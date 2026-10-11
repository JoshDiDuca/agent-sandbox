# windows-development-sandbox: notes for agents

A CLI (`sandbox`, also `agent-sandbox` / `claude-sbx` ...) that starts a disposable Windows Sandbox for a project, with
or without an AI agent. You are usually developing it INSIDE the sandbox it creates. Only `C:\Workspace\<project>` (this
repo, a host folder) and `C:\AgentData` (tools/state/logs) survive the wipe: put behaviour in code, not in this machine.
Downloads for testing go in your scratchpad. User docs: README.md and docs/. Contributor summary: CONTRIBUTING.md.

## Layout
- `src/cli/`: `manifest.ts` defines every command, argument and option once (zod). `args.ts` builds the commander
  parser from it (pure `parseCli`), `menu.ts` builds the interactive menu, `settings.ts` is the menu's settings screen
  (generated from the config schema), `index.ts` dispatches (no args: menu, `sandbox <agent>`: launch).
  `commands/*.ts`, one file per area (`launch`, `sessions` incl. `db`, `data`, `repair`, `setup`, `accounts`,
  `maintenance`), `context.ts` has what they share.
- `src/core/`: `schema.ts` (zod: every setting; JSON Schemas in `schemas/` are generated from it), `config.ts`
  (`DEFAULTS`, loading), `local-config.ts` (`.sandbox-config.json`, tighten-only rules, hash-based approvals),
  `workspace.ts` (run resolution, safe-workspace checks, version files), `detect-*.ts` (pure: project files to
  databases / toolchains / pwsh), `util.ts`, `types.ts`.
- `src/host/`: runs on the PC. `generate.ts` (.wsb + launch folder + session.json), `project-scan.ts`, `secrets.ts`
  (strips credentials from everything copied in), `claude-profile.ts`, `channel.ts` (run-folder channel + attach),
  `repo-guard.ts` (quarantines what the sandbox planted), `platform.ts`, `terminal.ts`, `window.ts`, `accounts.ts`,
  `personalize.ts`, `cleanup.ts`.
- `src/guest/`: runs in the sandbox (bundled by esbuild into `dist/runtime/*.js`). `main.ts` (boot), `daemon.ts`
  (requests), `view.ts`, `gitguard.ts`, `db.ts` (`sbx-db`), `setup/*`, and `toolchains/*`: `index.ts` is the parallel
  install scheduler (steps with `after` dependencies, PATH merged in plan order), one module per area (`node`, `python`,
  `native` = C/C++/Rust/.NET/Mesa, `go`, `java`, `scripting` = Ruby/PHP/VC++, `runtimes` = Bun/uv/Deno, `managers` =
  Volta/pyenv, `databases`, `git`, `vscode`), `common.ts` (resolveCached with a 1-day TTL, installOnce, `auto`
  detection), `versions.ts` (pure version pickers).
- `src/shared/`: both sides. Channel `schema.ts`, `rundir.ts`, `pty-client.ts`, `download.ts` (streamed, hashed; GitHub
  page fallback for the API rate limit), `netrules.ts`, `system.ts`, `guest-paths.ts`, `safe-remove.ts`.
- `src/sync/`: history, claude-mem and the background watcher.
- `sandbox/`: boot scripts (`logon.cmd`, `trust.cmd`, `bootstrap.ps1`, then `runtime\main.js`) and C# helpers compiled
  in the sandbox by csc (`ptyhost.cs` ConPTY bridge, `gitshim.cs`, `vswhere.cs`).
- `scripts/`: `install.ps1` (the `irm | iex` installer, PowerShell 5.1), `bundle.mjs`, `schemas.mjs`,
  `install-global.mjs`, `publish-npm.mjs`.
- `src/selftest/`: `npm test`, split by area. Live tests need Windows (csc + ConPTY).

## Rules
- `npm run build` = tsc + esbuild bundle + schema generation. Commit changed `schemas/*.json`.
- `npm test` must end with the text `ALL TESTS PASSED`: gate on that text, not on the exit code. The live tests (ConPTY,
  daemon, git shim) can flake under load, so run once more before assuming a real failure.
- The self-test refuses to run outside a Windows Sandbox or GitHub Actions (`onThrowawayMachine` in
  `src/selftest/index.ts`). Never run it on a real PC.
- Inside a sandbox, commands that control the sandbox from outside (`launch`, `attach`, `exec`, `stop` ...) fail with a
  clear message (`requireOnPc`); `db` runs `dist/runtime/db.js` directly.
- Tests use only temp folders they create. Never the real `~/.agent-sandbox`, registry, PATH, profile or global git config.
- Arrow functions, lodash where it shortens code, zod for every shape read from disk. Keep the compact style.
- Messages are short, plain English with no jargon. Errors the user can act on use `fail(message, fix)`.
- The guest is hostile. Host code never executes guest data, never follows links under the data folder
  (`assertNoLinks`), keeps its own state outside it, validates everything read from `run/`, prints guest text through
  `safeText`, and reads workspace files with bounded effort (no unbounded regexes on them).
- A repo's `.sandbox-config.json` is untrusted: it needs a hash-based approval, and may only make protections stricter
  (`NEVER_LOOSER` in `local-config.ts`). Never add storage, executables, secrets or host folders to `LocalOverrides`.
- Host code must never import guest modules with side effects (`guest/env.ts` reads session.json on load). Pure
  helpers live in side-effect-free files (`versions.ts`, `gitrules.ts`, `detect-databases.ts`).
- Never spawn programs by bare name: use `SYSTEM.*` or absolute paths (cwd is often the workspace).
- New toolchain: a module, a step in `toolchains/index.ts`, schema + `DEFAULTS` + `config.example.json`, markers in
  `common.ts` for `auto`. Long-running work uses `execAsync` / async downloads so parallel steps keep going. Update docs.
- New setting or command: schema.ts / manifest.ts first (flags, menu and JSON Schema follow), then docs. The self-test
  checks that `config.example.json` equals `DEFAULTS`.
- C# helpers: C# 5 only (the compiler that ships with Windows).
- Host Node may be 22.0.0 (CI tests it): no APIs or dependencies that need newer (commander 14, @inquirer/prompts 7).

## Gotchas
- Mapped folders (this repo, `C:\AgentData`) refuse symlinks, junctions and rename-over.
  - Never `sed -i` here: it leaves `sedXXXXXX` files. Use the Edit tool.
  - Moving a folder from the local disk into one fails silently. Tools that unpack to %TEMP% and move (nvm) get a TEMP
    inside the target.
  - Git Bash `rm -rf` can fail silently there too. Check that the folder is really gone.
- Never read, set or override HOME / USERPROFILE (or `$home` in PowerShell) in scripts or tests. Use explicit paths.
- Backslash escapes get eaten in shell heredocs, `node -e` and template literals. Write TypeScript with the Edit/Write
  tools, not through the shell.
- SQL Server LocalDB cannot start inside Windows Sandbox. Docker cannot run there (no nested virtualization).
- Handled in code, keep it that way: postgres via `pg_ctl` (postgres.exe refuses admin), Volta's shims are copies of
  `volta-shim.exe`, pnpm hoisted and Bun's cache on local disk (no symlinks on mapped folders), GitHub page fallback
  for the API rate limit, nvm's TEMP on the data disk, `.gitattributes` fixes line endings.
- Inside a sandbox, `sandbox launch/claude/attach` try to start a nested sandbox and fail. Test CLI behaviour with
  unit tests, `--help`, `config`, `data` and `doctor`.

## Databases on demand
`sbx-db` is `src/guest/db.ts` (bundled to `dist/runtime/db.js`). It reads `session.json`: `databases` are the plans for
this project, `databaseCatalog` lists every database it may start later. `sandbox db` runs it directly inside a sandbox
and through the exec channel from the PC; `--database <name>` adds plans at launch.

## Workflows
- In `release.yml` / `ci.yml`, a `pwsh` step ends with the exit code of its last native command. End steps with
  `exit 0` after native commands that may return non-zero on purpose (git rev-parse, npm view ...).
- CI also builds on the official Node 22.0.0 zip (setup-node's 22.0.0 has a broken npm). Releases run no tests.

## Releasing
Bump `version` in `package.json` and push to master. CI tags `v<version>` and publishes to GitHub Releases, GitHub
Packages and npm. The first npm publish is done once from the PC with `npm run publish:npm` (builds, packs, publishes;
no tests). See docs/development.md.
