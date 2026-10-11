# windows-development-sandbox: notes for agents

A CLI (`sandbox`, also `agent-sandbox` / `claude-sbx` ...) that starts a disposable Windows Sandbox for a project, with
or without an AI agent. You are usually developing it INSIDE the sandbox it creates. Only `C:\Workspace\<project>` (this
repo, a host folder) and `C:\AgentData` (tools/state/logs) survive the wipe: put behaviour in code, not in this machine.
Downloads for testing go in your scratchpad. User docs: README.md and docs/. Contributor summary: CONTRIBUTING.md.

## Layout
- `src/cli/`: `manifest.ts` defines every command, argument and option once (zod). `args.ts` builds the commander
  parser from it (pure `parseCli`), `menu.ts` builds the interactive menu (`history.ts` remembers the last commands,
  `colors.ts` is the one ANSI colour helper), `settings/` is the menu's settings screen (`schema.ts` reads the zod
  schemas, `prompts.ts` one prompt per kind of setting, `edit.ts` jsonc-preserving edits, `index.ts` the screen for your
  file and the project's `.sandbox-config.json`), `index.ts` dispatches (no args: menu, `sandbox <agent>`: launch).
  `commands/`: one file per area (`launch`, `sessions` incl. `db`, `accounts`, `maintenance`) or a folder when an area
  has several parts: `repair/` (`checks.ts` the checks, `finders.ts` pure finders, `types.ts`), `data/` (`collect.ts`
  what is stored, `clean.ts` targets and removal, `remove.ts` link-safe delete), `setup/` (`facts.ts` what the PC has,
  `checks.ts` the checklist). `context.ts` has what commands share (context, `table`, `printJson`, `requireOnPc`).
  Several projects: `project.ts` is the ONE helper every command uses to find "the project this folder is in"
  (`locateHere` looks, `joinHere` registers); `restart.ts` the consented restart that adds folders; `projects.ts` the
  `sandbox projects` command; `user-config.ts` edits your config file; `../menu-multi.ts` "Start several agents".
- `src/core/`: `schema.ts` re-exports `schema/` (zod, split by area: `common`, `sandbox`, `toolchains`, `databases`,
  `profile`, `harness`, `config` = user config + project overrides, `json-schema`; JSON Schemas in `schemas/` are
  generated from it), `config.ts` (`DEFAULTS`, loading), `local-config.ts` (`.sandbox-config.json`, tighten-only rules,
  hash-based approvals), `workspace.ts` (run resolution, version files), `safe-paths.ts` (which folders may be mapped),
  `detect-*.ts` (pure: project files to databases / toolchains / pwsh), `disk.ts` (sizes, free space, `humanBytes`),
  `prompt.ts` (y/N and typed confirmations), `util.ts`, `types.ts`.
- `src/host/`: runs on the PC. `generate.ts` (launch folder + session.json) with `launch/` (`wsb.ts` the .wsb,
  `mappings.ts` mapped folders, `stage.ts` hooks, runtime and git identity), `project-scan.ts` (bounded reads of the
  project), `pc-scan.ts` (what this PC has), `database-plan.ts`, `secrets.ts` (strips credentials from everything copied
  in), `claude-profile.ts`, `channel.ts` (run-folder requests and waiting), `attach.ts` (terminal attach, Hyper-V
  address check), `repo-guard.ts` (quarantines what the sandbox planted), `platform.ts`, `terminal.ts`, `window.ts`,
  `accounts.ts`, `personalize.ts`, `cleanup.ts`, `test-guard.ts`. Several projects: `projects.ts` (host-only registry
  of the running sandbox's projects + known projects, and `ProjectMapper`: roots, then `wsb share`, else
  `NeedsRestart`), `join.ts` (resolve + check + register a folder, build its `ProjectSpec`), `launch/projects.ts`
  (roots and projects mapped at boot), `wsb.ts` (the Windows Sandbox CLI adapter, untested).
- `src/guest/`: runs in the sandbox (bundled by esbuild into `dist/runtime/*.js`): `main.ts` (boot), `daemon.ts`
  (request loop) with `daemon/` (`session`, `exec`, `shutdown`, shared `state`, `project` = provisioning a project
  that joined after boot, per-session env), `project-context.ts` (AsyncLocalStorage: which project a toolchain step
  is for, and `duringSession()`: never switch machine-wide state then), `boot-env.ts` / `project-env.ts` (the boot's
  base environment, pure part separate), `project-status.ts`, `view.ts`, `gitguard.ts`, `db.ts`,
  `ports.ts`, `cmdline.ts` (agent command-line quoting), `helpers.ts` (compiles the C# helpers), `ptyhost.ts`,
  `setup/*`, and `toolchains/*`: `index.ts` is the parallel install scheduler, `plan.ts` lists the steps, `common.ts`
  shared helpers (resolveCached, installOnce, installFromGithub, downloadFile, `auto` detection), `versions.ts` (pure
  version pickers), `leftovers.ts`; one module per area: `node`, `python`, `go`, `java`, `managers`, `runtimes`, `git`,
  `cli`, `pwsh`, `vscode`; `scripting/` (ruby, php, vcruntime); `native/` (cpp, rust, binstall, dotnet, mesa, msvc/);
  `databases/` (index, server, one file per database).
- `src/shared/`: both sides. Channel `schema.ts`, `rundir.ts`, `pty-client.ts`, `download.ts` (streamed to `.part`,
  hashed; `downloads.requireChecksum`; GitHub page fallback for the API rate limit), `netrules.ts`, `system.ts`,
  `guest-paths.ts`, `projects.ts` (pure: project ids, host <-> guest folders, `C:\Projects`), `safe-remove.ts`,
  `test-guard.ts`.
- `src/sync/`: history, claude-mem and the background watcher.
- `sandbox/`: boot scripts (`logon.cmd`, `trust.cmd`, `bootstrap.ps1`, then `runtime\main.js`) and C# helpers compiled
  in the sandbox by csc: `ptyhost.cs` (ConPTY bridge), `gitshim.cs`, `vswhere.cs`, `openssl.cs`.
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
- Several projects: the launch folder is the primary workspace; other projects are under `C:\Projects` (roots, boot
  mapped, wsb shares). Anything that assumed ONE workspace must take the project from `ProjectSpec` / the registry.
  Toolchain steps read the project folder through `projectWorkspace()`, and with `duringSession()` must not change
  machine-wide state that running sessions use. Machine-wide protections are never loosened (`core/project-policy.ts`).
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
