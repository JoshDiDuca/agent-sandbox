# Parity tasks: one area at a time (spec for contributors)

## Start here (instructions for the agent picking this up)

You are finishing the web UI by moving each area of the tool into the shared core, so the command line, the menu and
the web UI all run the same code. Work like this:

1. Work in your own git worktree of this repository, on a branch made from the latest `master`
   (`git worktree add <folder> -b web-ui/<area> master`). Never commit to `master` yourself.
2. Read, in order: `CLAUDE.md` (all of it: the hard rules, the coding standard, the Gotchas), then
   [shared-core.md](shared-core.md) (the contract, then its "As built" and "How to add a feature" sections), then the
   rest of this file.
3. Do the areas in the table at the end of this file **one at a time, in order**, starting with area 1 (agents). Copy
   the three reference features in `src/app/features/sandbox`, `sessions` and `settings`; follow "Steps for every
   area" and "Rules" below exactly.
4. An area is done only when `npm run build`, `npm run lint` and `npm run format:check` pass and `npm test` prints
   `ALL TESTS PASSED` (gate on that text, not the exit code; live tests can flake: run once more before calling a
   failure real). Do not weaken or delete tests to make them pass; if a test is wrong, say so in your report.
5. Commit each area separately, with a clear message saying what moved where. Then **stop** and write a short report:
   the branch name, what you changed, what you deleted, anything you were unsure about, anything left undone. Wait for
   the review before starting the next area.
6. When something in this spec is unclear or seems wrong, do not guess: stop and say what is unclear in your report.

The environment: you run inside a Windows Sandbox on a mapped folder, so symlinks and npm workspaces do not work,
`sed -i` leaves stray files (use your editor's file tools), and shell heredocs and `node -e` eat backslashes (write
code with file tools). Never run the self-test on a real PC, and never touch the real `~/.agent-sandbox`, the registry,
PATH or the user's profile.

## Read first

Read first, in this order: CLAUDE.md, [shared-core.md](shared-core.md) (the contract, then its "As built" and "How to
add a feature" sections), then the three reference features in `src/app/features/sandbox`, `src/app/features/sessions`
and `src/app/features/settings`, and how the surfaces draw them: `src/cli/menu/pages/sessions-page.ts` (a menu section
that is one view), `src/cli/menu/pages/sandbox-page.ts` (a view as one category of a section), `web/src/pages/ViewPage.tsx`.
Every task below is "make this area look like the reference features". Do one area per change; never two at once.

## Steps for every area (mechanical)

1. `src/app/features/<area>/<area>.def.ts`: queries, operations and the view (copy `sessions.def.ts`). Every input and
   output field has `.describe()`. Give each operation and query a CLI hint that spells the existing command exactly
   (`name`, `action` for an action of a hand-written command, `positional`, `flags` with `shownAs`/`short`, `yes`,
   `json` and `shapeJson` when the `--json` shape must stay). `text(output)` is the line the CLI prints.
2. `<area>.run.ts`: `implement(def, async (ctx, input, io) => ...)` over the existing services; questions through `io`
   (`implied: true` where the CLI never asked, `noTerminal` where it failed with a specific message), `cancelled()` on
   a no. Another user's sandbox: `useSharedSandbox(ctx, action, typedConfirm(io))`.
3. `index.ts` barrel; add the definitions to `src/app/features/defs.ts` and the implementations to
   `src/app/registry.ts`.
4. Menu: make the area's page render the view: `menuView(page)` gives rows, keys and Enter labels, `resolve()` the
   action, `MenuOperations.perform()` runs it (see `sessions-page.ts`). Add the view to `src/cli/menu/views.ts`.
5. Web: add the view to `NAV` in `src/app/features/defs.ts` (replacing the section's `elsewhere`). Nothing else unless
   the area needs a new kind of input or target.
6. CLI: remove the manifest entry (or the action branch of the hand-written command) and the handler; the hint makes
   the command. Delete the old command file and the menu code that did the work.
7. Remove `link({ kind: 'command', argv: [...] })` targets that pointed at this area from other views, and use the new
   operation instead (Sessions' "Reopen last sessions" points at `resume`; Sessions' and the web's "Start" use the
   `start-agent` target until task 1 makes `agents.start`).
8. `npm test app` must show no parity gap; run the area's existing suites; `npm run lint`, `npm run format:check`.

## Rules (non-negotiable)

- Logic lives in `src/app/features/<area>/` only. The CLI command, the menu page and the web page render the area's
  views and call its operations; they contain no feature logic. If you find logic in `src/cli/commands/...` or
  `src/cli/menu/pages/...`, move it into the feature, then delete the old copy.
- `<area>.def.ts` is pure (zod, labels, view builders): no `node:` imports, no services. `<area>.run.ts` does the work
  through the existing services (`src/cli/services`, `src/host/*`) and talks only through `io`.
- No `console.log`, no `@inquirer`, no React or TUI imports in a feature. Errors: `fail(message, fix)`.
- Inputs and outputs are zod schemas with `.describe()` on every field (that text becomes the label/help everywhere).
- Every operation is on every surface, or declares `surfaces: { except: { <surface>: '<reason>' } }`.
- Keep behaviour: the CLI's text and flags, the menu's rows and keys stay as they are unless the task says otherwise.
  The existing tests for that command/page must keep passing; update them only where output moved, not changed.
- Web: Mantine components only (no hand-written CSS beyond `app.css` tokens); every page works at 360 px wide. A new
  kind of value is a new Field kind in `src/app/kernel/fields.ts` with its input in `web/src/render/FieldInput.tsx` and
  its editor in `src/cli/menu/settings/value-editor.ts`, never a one-off form.
- Done means: `npm run build`, `npm run lint`, `npm run format:check` pass; `npm test` prints ALL TESTS PASSED; the parity
  test shows no gap for the area; docs/commands.md updated if a command changed.

## Areas

Each line: what to move, where it lives today, what the web page must offer.

| # | Area | Today | Operations / queries / views to define | Web page |
| --- | --- | --- | --- | --- |
| 1 | agents | menu/pages/agents-page.ts, menu/add-agent.ts, commands/launch | agents.list, agents.start (attach/window/folder options, several, no agent), agents.add, agents.makeDefault, agents.remove; view `agents` | Agents: cards per agent with Start; Add agent form; options panel. agents.start replaces the `start-agent` target, `web/src/pages/NewSessionModal.tsx` and `POST /api/sessions` (keep the endpoint's tests until it goes) |
| 2 | projects | commands/projects, services/projects-service.ts, menu Sandbox > Projects | projects.list, projects.add/remove/include/exclude, roots.list/add/remove, projects.all | Projects: table + roots list, path picker dialog |
| 3 | accounts | commands/accounts.ts, services/accounts-service.ts, menu/pages/accounts-page.ts | accounts.list(agent), save, use, default, rename, remove | Accounts: per-agent tabs, actions with confirmation |
| 4 | data | commands/data, services/data-service.ts, Maintenance > Data & storage | data.show (sizes, streamed measuring), data.clean (checklist), clean (old launch folders) | Data: size table, clean checklist with confirmation |
| 5 | storage | commands/storage, host/storage | storage.show, storage.move/use (path picker, size/time estimate, confirm), storage.contained on/off/status | Storage: current folder, move dialog with estimate. The web's `io.path` is a text field today: a folder browser needs a query that lists folders on the server (`files.list`, loopback only, no file contents) |
| 6 | apps | menu/apps.ts, menu/pages/apps-page.ts | apps.list (catalogue + custom, scope user/project), apps.toggle, apps.custom edit, apps.request | Apps: grouped grid with toggles, custom programs form |
| 7 | health | commands/repair, host/health, commands/setup | health.doctor (streams check results), health.repair (lists changes, confirm, streams fixes, log path), setup.check/enable | Health: live check list, Fix button, repair log link |
| 8 | updates | services/update-service.ts, commands/maintenance/update.ts | updates.status, check, install, rollback, auto on/off, migrate | Updates: version card, buttons, failed-update notice |
| 9 | logs | services/logs-service.ts | logs.list, logs.read (tail, follow as a live query) | Logs: list + viewer with follow |
| 10 | vpn | commands/vpn.ts, menu/vpn-login.ts | vpn.status, vpn.login (secret fields), vpn.logout | VPN: status card, login form (secret inputs), warnings |
| 11 | engine | commands/engine.ts, host/engines | engine.status, engine.check(id) | Engine: capabilities table, check results with fixes |
| 12 | web | commands/web.ts | web.status/start/stop/open (CLI and menu only: `surfaces: { except: { web: 'the page is the web UI' } }`) | none |
| 13 | settings export/import | menu/settings/share.ts, commands/maintenance/config-share.ts | settings.export/import (diff, confirm) in the settings feature | Settings: Export/Import buttons with diff modal (page actions of `settingsView`) |

After all areas: remove `cli/manifest.ts` entries that became operation CLI hints, and delete any page or command file
that only forwards to a feature.
