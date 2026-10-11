# agent-sandbox — notes for agents

You are usually developing this INSIDE the Windows Sandbox it creates. Only these survive the wipe:
`C:\Workspace\<project>` (this repo = host folder), `C:\AgentData` (tools/state/logs). Anything you install
elsewhere (winget, global npm outside nvm, scratch downloads) is gone next boot — put behaviour in code, not in this machine.

## Layout
- `src/` host CLI (TypeScript → `dist/`): `cli.ts` usage/dispatch, `commands.ts` command bodies, `args.ts`,
  `config.ts` (defaults + `~/.agent-sandbox/config.json`), `localconfig.ts` (`.sandbox-config.json` validation/trust),
  `workspace.ts` (run resolution, version files), `sandbox.ts` (.wsb + launch folder), `host.ts`, `attach.ts`
  (host side of the run-folder channel + terminal attach), `accounts.ts`, `history.ts`/`sync.ts` (history + claude-mem),
  `personalize.ts`, `terminal.ts`, `window.ts` (headless), `cleanup.ts`, `api.ts` (programmatic API), `bin/*` (npm bins).
- `src/guest/` runs INSIDE the sandbox; copied into the launch folder, so **Node built-ins only, no lodash**:
  `main.ts` (boot), `daemon.ts` (sessions + host requests), `view.ts` (terminal tab), `toolchains.ts`, `provision.ts`,
  `ptyclient.ts` (wire protocol), `rundir.ts` (channel files + validation), `guide.ts` (agent manifest).
- `sandbox/` guest assets: `logon.cmd` → `bootstrap.ps1` → `guest/main.js`; `ptyhost.cs` (ConPTY bridge, C# 5, compiled in-guest by csc).

## Rules
- Build `npm run build`; test `npm test` (offline + live ptyhost/daemon tests; must say ALL TESTS PASSED).
- Host-side code: arrow functions, lodash where it shortens code. Guest code: no dependencies.
- Host <-> guest only via `run/` JSON files: guest acts on the `GuestRequest` kinds only; host validates all guest data.
