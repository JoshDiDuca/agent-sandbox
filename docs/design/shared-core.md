# One core for the CLI, the menu and the web UI (design and plan)

Status: **in progress** (core and reference features first; then feature-by-feature parity; then the web UI grows to
everything the menu does). This document is the contract every contributor (human or agent) follows.

## The rule

A feature is written **once**, in the shared core: what it takes, what it does, what it shows, what it asks. The three
surfaces only render it:

| Surface | Renders | Talks to the core |
| --- | --- | --- |
| Command line (`sandbox <command>`) | plain text and `--json` | in-process |
| Menu (`sandbox`, full-screen) | the TUI toolkit (`src/cli/tui`) | in-process |
| Web UI (`sandbox web`) | React + Mantine | typed RPC over the existing loopback server (WebSocket) |

Change a feature in the core and all three change. A self-test fails when an operation is not reachable from every
surface (unless it declares why, e.g. "attach takes over a real terminal; the web UI has the terminal page instead").

## Not a multi-package monorepo, on purpose

This repo lives on a mapped folder (Windows Sandbox) where npm workspaces, `file:` dependencies and symlinked packages
fail (CLAUDE.md, Gotchas). So "packages" are folders with barrels and ESLint boundary rules in one package, built by
tsc (CLI) and esbuild (web). The boundaries are as strict as separate packages and could be split out later without
code changes.

## Layers

```
src/app/                         THE SHARED CORE (no terminal, no DOM, no printing)
  kernel/                        pure: may be imported by the web bundle
    define.ts                    defineOperation / defineQuery / defineView
    fields.ts                    zod -> Field descriptors (one form model for TUI and web)
    view.ts                      view-model types (Page, Section, Item, Action, Table, Tone, Badge)
    io.ts                        the questions an operation may ask (confirm, choose, text, secret, path, checklist)
    errors.ts                    UserError -> { message, fix } (from core/util fail())
    rpc.ts                       the RPC message schemas (zod), shared by server and browser
  features/<area>/               one folder per area (sessions, sandbox, agents, projects, accounts, data, storage,
    <area>.def.ts                  settings, apps, health, updates, logs, vpn, engine, web)
                                 pure: ids, zod input/output, labels, groups, danger, view builders, parity exemptions
    <area>.run.ts                Node: the implementations (call today's services in src/cli/services and host/*)
    index.ts                     barrel; the web bundle imports only *.def.ts through features/defs.ts
  registry.ts                    every feature, by id (Node side); features/defs.ts = the pure half for the web
src/cli/                         surface 1 + 2
  args.ts / manifest.ts          commander built from operation definitions (CLI hints: positional args, flags,
                                 aliases) — manifest.ts shrinks to the CLI-only hints over time
  output/render-view.ts          view model -> plain text table / list / key-values; --json prints the output schema
  menu/render-view.ts            view model -> ListScreen items, categories, actions; Field -> the existing editors
  io-cli.ts / menu/io-menu.ts    OperationIO via @inquirer/prompts (CLI) and TUI dialogs (menu)
src/host/web/                    the RPC endpoint on the existing server (same auth, Host/Origin/CSRF checks)
web/src/                         surface 3
  rpc/                           typed client (types inferred from features/defs.ts), TanStack Query hooks
  render/                        view model -> Mantine components; Field -> Mantine inputs (@mantine/form + zod)
  pages/                         thin: a page = a view id (+ the terminal page, which is special)
```

Layering is enforced by ESLint `no-restricted-imports` (existing boundary config): `app/kernel` and `*.def.ts` import
only zod, lodash-es-free pure helpers and `core/schema`; `web/` imports only `app/kernel`, `app/features/defs.ts` and
`shared/web`; `*.run.ts` never imports `src/cli/tui` or React.

## Contracts

### Operation (does something)

```ts
export const restartSessions = defineOperation({
  id: 'sessions.restart',
  title: 'Restart sessions',            // menu row / web button / CLI summary
  summary: 'Restart this project\'s running agents in place; they resume their conversation.',
  group: 'Sessions',
  input: z.object({ all: z.boolean().default(false).describe('every project') }),
  output: z.object({ restarted: z.number() }),
  danger: false,                        // true: confirm first (text from `confirm`)
  surfaces: 'all',                      // or { except: { web: 'reason' } }
  cli: { name: 'restart', positional: [], flags: { all: '--all' } },
});
// sessions.run.ts
export const restartSessionsRun = implement(restartSessions, async (ctx, input, io) => {
  io.progress('Restarting…');
  ...
  return { restarted: n };
});
```

- Input and output are zod; every surface validates input before `run` and output after (the web gets typed data).
- `io` is the only way to interact: `io.progress(text)`, `io.log(line)`, `await io.confirm(...)`, `io.choose`,
  `io.text`, `io.secret`, `io.path` (the path picker in the menu, a picker dialog in the web), `io.checklist`. No
  `console.log`, no `@inquirer` in features. Without a way to ask (CLI with no TTY), `io` fails with the existing
  "Add --yes" message (core/prompt.ts askRequired).
- Errors: `fail(message, fix)` as today; every surface shows message + fix the same way.
- Long work streams progress (spinner in the CLI, notice line in the menu, progress bar/toast in the web).

### Query (reads something, optionally live)

```ts
export const listSessions = defineQuery({
  id: 'sessions.list',
  input: z.object({ wide: z.boolean().default(false) }),
  output: ListedSessionsSchema,
  live: { everyMs: 2500 },              // the menu's LiveStatus and the web's subscriptions use the same rule
});
```

### View (what a screen shows)

```ts
export const sessionsView = defineView({
  id: 'sessions',
  title: 'Sessions',
  queries: { sessions: listSessions },
  build: ({ sessions }): Page => ({
    sections: [{ title: 'Running', items: sessions.map(s => ({ id: s.id, label: ..., hint: ..., tone: ...,
      actions: [action(restartSessions, { all: false }), action(attachSession, { id: s.id })] })) }],
    empty: { text: 'No sessions.', action: action(startAgent, {}) },
  }),
});
```

- A view is pure: queries in, a `Page` out. The menu turns a `Page` into a ListScreen (sections, categories, hints,
  key bar from actions); the web turns it into Mantine cards/tables/menus; the CLI prints it (status, sessions, data).
- Tones (`ok`, `warn`, `danger`, `muted`, `accent`) map to the TUI theme and to Mantine colours: one palette.

### Fields (forms)

`fields.ts` turns any zod schema (operation inputs, the whole config schema for Settings) into `Field`s:
kind (`boolean`, `enum`, `number` with min/max, `text`, `secret` — from `secret()`, `path` with file/folder — from the
existing `pathKindOf`, `list`, `map`, `object`), label, help (from `.describe()`), default, validation (the schema
itself). The menu's settings editors and the web's forms both consume `Field`s, so a new setting or option is
editable everywhere the moment it is in the schema. (The existing `menu/settings/schema-node.ts` and
`path-kind.ts` move into the kernel; the TUI editors stay in `menu/` and render Fields.)

### RPC (web only)

One WebSocket per page session on the existing server, after the existing cookie login and Origin check:
`{t:'call', id, op, input}` -> `{t:'progress'|'log'|'ask'|'result'|'error', id, ...}`; `{t:'answer', id, value}` answers an
`ask`; `{t:'subscribe', query, input}` -> `{t:'data', ...}` for live queries. All messages are zod schemas in
`app/kernel/rpc.ts`; the server validates every message and runs only registered operations whose `surfaces` include
`web`. The terminal bridge (`/api/sessions/:id/terminal`) stays as it is.

## Libraries

- Kept: zod 4 (all schemas), lodash (host side), commander 14, @inquirer/prompts 7, ws, React 18, xterm.js.
- Web: **Mantine 7** (`@mantine/core`, `@mantine/hooks`, `@mantine/form`, `@mantine/notifications`, `@mantine/modals`)
  with `mantine-form-zod-resolver`, **@tanstack/react-query 5** for queries/subscriptions, `@tabler/icons-react`.
  Mantine replaces Bootstrap: it gives accessible forms, modals, tables, notifications and dark/light theming out of the
  box, which is most of the web UI. All web libraries are dev dependencies bundled by esbuild; nothing new ships to
  the CLI.
- No new host runtime dependency is needed for the core (zod + the existing `ws`).
- Sandbox-side communication (C# ptyhost, the run\ file channel) is enough for 1:1; any upgrade there (e.g. hvsocket
  for the HCS engine) is done in C# 5 per CLAUDE.md, behind the same core operations.

## How to add a feature (checklist)

1. `features/<area>/<area>.def.ts`: the operation/query/view definitions (zod in/out, labels, CLI hints).
2. `<area>.run.ts`: the implementation, using services and `io` only.
3. Register both in `app/registry.ts` (and the def in `features/defs.ts`).
4. Nothing else: the CLI command, the menu row/page and the web page/button appear from the definitions. If a surface
   cannot have it, declare `surfaces: { except: { web: 'reason' } }`.
5. Tests: one test of `run` with fakes; the parity test checks reachability; the view snapshot test checks the Page.
6. Docs: docs/commands.md.

## Plan

1. **Kernel** (this phase): define.ts, fields.ts (moved from menu/settings), view.ts, io.ts, errors.ts, rpc.ts; the
   CLI/menu/web renderers of views and fields; the three IO adapters; the RPC endpoint and the web client; the parity
   and boundary tests; Mantine shell (layout with left navigation mirroring the menu's sections, theme, notifications).
2. **Reference features**, end to end on all three surfaces: `sandbox.status` + `sandbox.stop` + window show/hide,
   `sessions.list` + `sessions.restart` (+ the terminal page), `settings` (view + get/set/reset via Fields). These are
   the examples every later feature copies.
3. **Parity, area by area** (spec in [web-ui-tasks.md](web-ui-tasks.md)): agents, projects, accounts, data, storage,
   apps, health (doctor/repair streaming), updates, logs, vpn, engine, web. Each: move the logic behind the menu page
   and the CLI command into the feature, then delete the duplicated menu/CLI code.
4. **Web UI completion**: every view works in the browser; phone layout; the on-screen key row for the terminal.

Acceptance for 1:1: every menu page is a view; every CLI command is an operation or query; the parity test lists no
gaps; `npm test` passes; the menu looks and behaves as before (the existing menu tests and overflow checks pass).
