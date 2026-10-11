# agent-sandbox — notes for agents

You are usually developing this INSIDE the Windows Sandbox it creates. Only these survive the wipe:
`C:\Workspace\<project>` (this repo = a host folder) and `C:\AgentData` (tools/state/logs). Anything you install elsewhere
is gone next boot: put behaviour in code, not in this machine. Downloads for testing go in your scratchpad.

## Layout
- `src/cli/` commander CLI: `args.ts` (all commands/options, pure `parseCli`), `index.ts` (dispatch + friendly errors),
  `commands/*.ts` (one file per area).
- `src/core/` `schema.ts` (zod: every setting; JSON Schemas are generated from it), `config.ts` (defaults + user config),
  `local-config.ts` (`.sandbox-config.json` + approvals), `workspace.ts` (run resolution, version files), `util.ts`, `types.ts`.
- `src/host/` runs on the PC: `generate.ts` (.wsb + launch folder), `platform.ts`, `channel.ts` (host side of the run-folder
  channel + terminal attach), `accounts.ts`, `repo-guard.ts`, `personalize.ts`, `terminal.ts`, `window.ts`, `cleanup.ts`.
- `src/sync/` history, claude-mem and the background watcher.
- `src/shared/` used on both sides: channel `schema.ts`, `rundir.ts`, `pty-client.ts`, `download.ts`, `paths.ts`, `netrules.ts`.
- `src/guest/` runs in the sandbox: entry points `main.ts`, `daemon.ts`, `view.ts`, `gitguard.ts` (bundled by esbuild into
  `dist/runtime/*.js`), plus `setup/*` and `toolchains/*`.
- `sandbox/` boot scripts (`logon.cmd` → `trust.cmd` → `bootstrap.ps1` → `runtime\main.js`) and C# helpers compiled in
  the sandbox by csc (`ptyhost.cs` ConPTY bridge, `gitshim.cs`); C# 5 only.
- `src/selftest/` the test suite (`npm test`), split by area; live tests need Windows (csc + ConPTY).

## Rules
- `npm run build` = tsc + esbuild bundle + schema generation. `npm test` must end with ALL TESTS PASSED.
- Arrow functions, lodash where it shortens code, zod for every shape read from disk.
- The sandbox is untrusted: host code never executes guest data, never follows links under the data folder
  (`assertNoLinks`), keeps its own state outside it, and validates everything read from `run/`.
- Errors the user can act on use `fail(message, fix)`.
