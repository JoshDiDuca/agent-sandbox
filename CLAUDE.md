# windows-development-sandbox — notes for agents

A CLI (`sandbox`, also `agent-sandbox` / `claude-sbx` …) that starts a disposable Windows Sandbox for a project, with
or without an AI agent. You are usually developing it INSIDE the sandbox it creates. Only `C:\Workspace\<project>` (this
repo, a host folder) and `C:\AgentData` (tools/state/logs) survive the wipe: put behaviour in code, not in this machine.
Downloads for testing go in your scratchpad. User docs: README.md and docs/.

## Layout
- `src/cli/` — `manifest.ts` defines every command, argument and option once (zod); `args.ts` builds the commander
  parser from it (pure `parseCli`), `menu.ts` builds the interactive menu from it, `index.ts` dispatches (no args →
  menu, `sandbox <agent>` → launch). `commands/*.ts`, one file per area (`launch`, `sessions`, `data`, `repair`,
  `setup`, `accounts`, `maintenance`).
- `src/core/` — `schema.ts` (zod: every setting; JSON Schemas are generated from it), `config.ts` (defaults),
  `local-config.ts` (`.sandbox-config.json` + approvals), `workspace.ts` (run resolution, version files),
  `detect-databases.ts` (pure: project files → databases), `util.ts`, `types.ts`.
- `src/host/` — runs on the PC: `generate.ts` (.wsb + launch folder + session.json), `project-scan.ts` (reads project
  files for detection), `secrets.ts` (strips credentials from everything copied in), `claude-profile.ts`, `channel.ts`
  (run-folder channel + attach), `repo-guard.ts` (quarantines what the sandbox planted), `platform.ts`, `terminal.ts`,
  `window.ts`, `accounts.ts`, `personalize.ts`, `cleanup.ts`.
- `src/guest/` — runs in the sandbox (bundled by esbuild into `dist/runtime/*.js`): `main.ts` (boot), `daemon.ts`
  (requests), `view.ts`, `gitguard.ts`, `setup/*`, and `toolchains/*`: `index.ts` is the parallel install scheduler
  (steps with `after` dependencies, PATH merged in plan order), one module per area (`node`, `python`, `native` =
  C/C++/Rust/.NET/Mesa, `go`, `java`, `scripting` = Ruby/PHP/VC++, `runtimes` = Bun/uv/Deno, `managers` =
  Volta/pyenv, `databases`, `git`, `vscode`), `common.ts` (resolveCached with a 1-day TTL, installOnce, `auto`
  detection), `versions.ts` (pure version pickers).
- `src/shared/` — both sides: channel `schema.ts`, `rundir.ts`, `pty-client.ts`, `download.ts` (streamed, hashed;
  GitHub page fallback for the API rate limit), `netrules.ts`, `system.ts`.
- `src/sync/` — history, claude-mem and the background watcher.
- `sandbox/` — boot scripts (`logon.cmd` → `trust.cmd` → `bootstrap.ps1` → `runtime\main.js`) and C# helpers compiled
  in the sandbox by csc (`ptyhost.cs` ConPTY bridge, `gitshim.cs`); C# 5 only.
- `scripts/` — `install.ps1` (the `irm | iex` installer, PowerShell 5.1), `bundle.mjs`, `schemas.mjs`,
  `install-global.mjs`. `.github/workflows/release.yml` releases automatically when package.json's version is new.
- `src/selftest/` — `npm test`, split by area; live tests need Windows (csc + ConPTY).

## Rules
- `npm run build` = tsc + esbuild bundle + schema generation. `npm test` must end with ALL TESTS PASSED.
- Arrow functions, lodash where it shortens code, zod for every shape read from disk.
- The sandbox is untrusted: host code never executes guest data, never follows links under the data folder
  (`assertNoLinks`), keeps its own state outside it, validates everything read from `run/`, prints guest text through
  `safeText`, and reads workspace files with bounded effort (no unbounded regexes on them).
- Host code must never import guest modules with side effects (`guest/env.ts` reads session.json on load); pure
  helpers live in side-effect-free files (`versions.ts`, `gitrules.ts`, `detect-databases.ts`).
- Never spawn programs by bare name; use `SYSTEM.*` / absolute paths (cwd is often the workspace).
- Errors the user can act on use `fail(message, fix)`.
- New toolchains: a module + a step in `toolchains/index.ts` + schema/defaults + markers in `common.ts` for `auto`;
  long-running work uses `execAsync` / async downloads so parallel steps keep going. Update README/docs too.

## Gotchas
- Mapped folders (this repo, `C:\AgentData`) refuse symlinks/junctions and rename-over: never `sed -i` here (it
  leaves `sedXXXXXX` files), use the Edit tool; pnpm runs hoisted, Bun's cache lives on local disk.
- Some files have CRLF endings; normalise before multi-line string replacements.
- The self-test must not touch the real `~/.gitconfig` (it once broke `safe.directory`).
- GitHub's API allows 60 unauthenticated requests/hour per IP; `githubAsset` falls back to the release pages.
- postgres.exe refuses to run as admin: start it through `pg_ctl`. SQL Server LocalDB cannot start in Windows Sandbox.
- Volta's portable zip lacks the node/npm/yarn/pnpm shims: they are copies of `volta-shim.exe`.
- Host Node can be 22.0.0: no APIs or dependencies that need newer (commander 14, @inquirer/prompts 7).
