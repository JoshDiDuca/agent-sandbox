# Parity tasks: one area at a time (spec for contributors)

Read first, in this order: CLAUDE.md, [shared-core.md](shared-core.md) (the contract), then the three reference
features in `src/app/features/sandbox`, `src/app/features/sessions` and `src/app/features/settings`. Every task below is
"make this area look like the reference features". Do one area per change; never two at once.

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
- Web: Mantine components only (no hand-written CSS beyond `app.css` tokens); every page works at 360 px wide.
- Done means: `npm run build`, `npm run lint`, `npm run format:check` pass; `npm test` prints ALL TESTS PASSED; the parity
  test shows no gap for the area; docs/commands.md updated if a command changed.

## Areas

Each line: what to move, where it lives today, what the web page must offer.

| # | Area | Today | Operations / queries / views to define | Web page |
| --- | --- | --- | --- | --- |
| 1 | agents | menu/pages/agents-page.ts, menu/add-agent.ts, commands/launch | agents.list, agents.start (attach/window/folder options, several, no agent), agents.add, agents.makeDefault, agents.remove; view `agents` | Agents: cards per agent with Start; Add agent form; options panel |
| 2 | projects | commands/projects, services/projects-service.ts, menu Sandbox > Projects | projects.list, projects.add/remove/include/exclude, roots.list/add/remove, projects.all | Projects: table + roots list, path picker dialog |
| 3 | accounts | commands/accounts.ts, services/accounts-service.ts, menu/pages/accounts-page.ts | accounts.list(agent), save, use, default, rename, remove | Accounts: per-agent tabs, actions with confirmation |
| 4 | data | commands/data, services/data-service.ts, Maintenance > Data & storage | data.show (sizes, streamed measuring), data.clean (checklist), clean (old launch folders) | Data: size table, clean checklist with confirmation |
| 5 | storage | commands/storage, host/storage | storage.show, storage.move/use (path picker, size/time estimate, confirm), storage.contained on/off/status | Storage: current folder, move dialog with estimate |
| 6 | apps | menu/apps.ts, menu/pages/apps-page.ts | apps.list (catalogue + custom, scope user/project), apps.toggle, apps.custom edit, apps.request | Apps: grouped grid with toggles, custom programs form |
| 7 | health | commands/repair, host/health, commands/setup | health.doctor (streams check results), health.repair (lists changes, confirm, streams fixes, log path), setup.check/enable | Health: live check list, Fix button, repair log link |
| 8 | updates | services/update-service.ts, commands/maintenance/update.ts | updates.status, check, install, rollback, auto on/off, migrate | Updates: version card, buttons, failed-update notice |
| 9 | logs | services/logs-service.ts | logs.list, logs.read (tail, follow as a live query) | Logs: list + viewer with follow |
| 10 | vpn | commands/vpn.ts, menu/vpn-login.ts | vpn.status, vpn.login (secret fields), vpn.logout | VPN: status card, login form (secret inputs), warnings |
| 11 | engine | commands/engine.ts, host/engines | engine.status, engine.check(id) | Engine: capabilities table, check results with fixes |
| 12 | web | commands/web.ts | web.status/start/stop/open (CLI and menu only: `surfaces: { except: { web: 'the page is the web UI' } }`) | none |
| 13 | settings export/import | menu/settings/share.ts, commands/maintenance/config-share.ts | settings.export/import (diff, confirm) | Settings: Export/Import buttons with diff modal |

After all areas: remove `cli/manifest.ts` entries that became operation CLI hints, and delete any page or command file
that only forwards to a feature.
