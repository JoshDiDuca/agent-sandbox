# windows-development-sandbox: notes for agents

A CLI (`sandbox`, also `agent-sandbox` / `claude-sbx` ...) that starts a disposable Windows Sandbox for a project, with
or without an AI agent. You are usually developing it INSIDE the sandbox it creates. Only `C:\Workspace\<project>` (this
repo, a host folder) and `C:\AgentData` (tools/state/logs) survive the wipe: put behaviour in code, not in this machine.
Downloads for testing go in your scratchpad. User docs: README.md and docs/. Contributor summary: CONTRIBUTING.md.

## Layout
Feature folders, each with an `index.ts` barrel (re-exports only). Other folders import the barrel; inside a folder,
import siblings directly, never your own barrel. Guest code imports files directly, except the `guest/toolchains`,
`guest/databases` and `guest/apps` barrels.
- `src/cli/`: `manifest.ts` defines every command, argument and option once (zod; `as const satisfies`, `CommandName`).
  `args.ts` builds the commander parser from it (pure `parseCli`), `argv.ts` the `--config` handling, `index.ts`
  dispatches (no args: menu, `sandbox <agent>`: launch) through `commands/registry.ts` (`HANDLERS`), `report.ts`,
  `history.ts` (the last commands), `validate.ts`. `output/` (colours, progress lines and `follow()`, `table`,
  `printJson`). `tui/` is the screen toolkit and `menu/` the menu (owned by the menu work; see their files).
  `commands/`: `launch/` (`Launcher`, `running.ts` sessions in the running sandbox, `prepare.ts`, `summary.ts` the
  launch table, `boot-wants.ts`, `boot-progress.ts`, `first-start.ts`, `add-root.ts`), `sessions/` (attach, list, status,
  exec + db, control, window), `projects/` (`here.ts` is the ONE helper every command uses to find "the project this
  folder is in": `locateHere` looks, `joinHere` registers; `restart.ts` the consented restart with a `Relauncher`;
  `projects.ts` the `sandbox projects` command), `maintenance/` (sync, logs, clean, config, doctor, host-claude, watch,
  audit), `repair/`, `data/`, `setup/`, `accounts.ts`, `agent-commands.ts`, `user-config.ts`, `context.ts`.
- `src/core/` (pure or host-side basics): `schema/` (zod by area, constants `XxxSchema`, types `Xxx`; JSON Schemas in
  `schemas/` are generated from it), `config/` (`defaults.ts` = `DEFAULTS`, `loader.ts`), `local-config/`
  (`.sandbox-config.json`: `file.ts`, `overrides.ts` tighten-only rules, `trust.ts` hash approvals and answers,
  `policy.ts` joining a running sandbox, `boot-wants.ts` what a project wants at boot), `run/` (`resolveRun`, the guest
  workspace, versions), `detect/` (pure: project files to databases / toolchains / pwsh, version pickers), `util/`
  (`errors.ts` `UserError`/`fail`/`errMsg`, fs, links, paths, text, jsonc, process), `safe-paths.ts`, `disk.ts`,
  `prompt.ts`, `package-info.ts` (`PACKAGE_ROOT`), `types.ts`.
- `src/shared/` (host and guest): `channel/` (zod message schemas, `RunDir`), `io/` (`JsonFile`, atomic writes,
  `safeRemove`), `download/` (`Downloader`: streamed, hashed, `requireChecksum`, progress; GitHub page fallback),
  `pty/` (the ptyhost protocol, client, `runTerminalClient`, `InputJoiner`, console VT input), `paths/` (guest paths,
  project ids and host <-> guest folders, `C:\Projects`), `network/`, `apps/` (the apps catalogue), `scripts.ts`
  (`scriptArgs`: run `sandbox\scripts\*.ps1` by path), `system.ts` (`SYSTEM.*`), `test-guard.ts`.
- `src/host/` (on the PC): `launch/` (`generateSandbox`, `wsb-file.ts`, `mappings.ts`, `session-file.ts`, `stage.ts`,
  `boot-projects.ts`, project/PC scans, database plan), `channel/` (`SandboxChannel`, attach), `projects/`
  (`ProjectRegistry`, `KnownProjects`, `ProjectMapper` with `NeedsRestart`, `join.ts`), `guard/` (`RepoGuard` with its
  `GuardRule`s, `RepoGuardStore`, quarantine, mark of the web), `profile/` (secrets stripping, Claude profile and
  logins, `AccountStore`, desktop look), `sandbox/` (platform, probe, doctor rows, the window, the `wsb` CLI adapter),
  `life/` (`LifeRecord`, `SessionLedger` = what to reopen, stop events, crash reports, `KeepAwake`, Windows Update), `workspace-view/` (workspaceFilter:
  `IgnoreRules`, `WorkspaceView`), `agent-commands/`, `audit/`, `network/` (port forwards), `storage/` (cleanup,
  `hostStateFile`), `tools/` (Windows Terminal, conpty.dll), `native.ts` (HostTools.exe and `native\scripts`),
  `test-guard.ts`.
- `src/sync/`: history and claude-mem sync, `sync-cycle.ts`, `sync-state.ts`, and the background `Watcher`.
- `src/guest/` (in the sandbox; bundled by esbuild into `dist/runtime/*.js` from `entries/`): `entries/` (main,
  daemon, view, gitguard, db, netproxy), `runtime/` (paths; `session.ts` and `log.ts` have side effects on import;
  process helpers incl. `runScript`, `csc.ts` compiles the C# helpers, project context), `boot/` (`Boot`: the steps as
  methods), `daemon/` (`Daemon`, `SessionManager`, `ProjectProvisioner`, `IdleShutdown`, exec, relays), `sessions/`
  (ptyhost, viewer, command lines), `agents/` (`AgentInstaller`), `setup/`, `network/`, `git/` (the git guard's
  decision), `audit/`, `toolchains/` (`ToolchainStep`s from `plan.ts`, `StepScheduler`, one module per toolchain under
  `languages/`, `native/`, `tools/`), `databases/` (`DatabaseServer` subclasses, `sbx-db`), `apps/` (`AppInstaller`).
  Portable core: guest code imports only `core/types.ts`, `core/schema/**`, `core/detect/{toolchains,versions}.ts` and
  `core/util/errors.ts` from core. Host code and tests may import only these guest files (no side effects):
  `git/decision`, `setup/git-rules`, `boot/project-env`, `audit/parse`, `sessions/cmdline`, `toolchains/catalogue`,
  `toolchains/tools/vscode-profile`. The `layout` suite checks all of this on the compiled output.
- `sandbox/` (copied into every launch folder): `boot/` (`logon.cmd` -> `trust.cmd`, SandboxTools, then
  `bootstrap.ps1` with its functions in `boot/bootstrap/`, then `runtime\main.js`), `scripts/` (verb-noun `.ps1` run by
  path), `csharp/` (C# 5, compiled in the sandbox by csc: `PtyHost.cs` the ConPTY bridge, `GitShim.cs`, `VsWhere.cs`,
  `OpenSsl.cs`, `CargoShim.cs`, `LinkGate.cs`; `SandboxTools/` built by logon.cmd: cpu-cap, page-file, memory-log;
  `Desktop.cs`, `VtInput.cs` loaded by scripts with Add-Type).
- `native/` (on the PC, shipped in the package): `csharp/HostTools/` (HostTools.exe, built on first use into
  `<storage>\bin`: keep-awake, stop-events, hide-window, show-window, user-path) and `scripts/` (the PowerShell
  fallbacks when it cannot be built, and `capture-look.ps1`).
- `scripts/`: `install.ps1` (the `irm | iex` installer, PowerShell 5.1, keeps its inline C#), `bundle.mjs`,
  `schemas.mjs`, `install-global.mjs`, `publish-npm.mjs`.
- `src/selftest/`: `npm test`, one suite per area (`<area>.test.ts`), helpers in `support/`. Live tests need Windows
  (csc + ConPTY).

## Coding standard
- Classes for state with behaviour or an identity with a lifecycle (a store file, a channel, a scheduler, a screen);
  pure helpers stay module functions. Composition; inheritance only for abstract bases with template methods.
  Constructor parameters `private readonly`; no `public` keyword; alternate constructors are static factories.
- Exported module functions are `function` declarations with explicit return types; arrows for callbacks.
- `interface` for object shapes, `type` for unions; `readonly` on data and inputs; constant tables `as const` /
  `satisfies`. No `enum` or `namespace`: string-literal unions, runtime lists as `as const` arrays.
- Errors the user can act on: `fail(message, fix)` (`core/util/errors.ts`). An empty `catch` says why in a comment.
- zod for every shape read from disk (`JsonFile` or `readValid`). lodash only in cli/, host/, sync/ and host-side core/.
- Prettier, 120 columns. Comments: a short file header, one-line `/** */` where a name is not enough, no banners.
- `node:` prefix for built-ins, `import type` for types. Only cli/ prints (existing host prints keep their order).
- No PowerShell or C# inside TypeScript strings: scripts are `.ps1` files run by path with parameters (JSON through a
  temp file), C# is in `.cs` files. C# 5 only (no interpolation, `?.`, `nameof`, expression bodies), Allman braces,
  P/Invoke in a nested `NativeMethods` class with `SetLastError`, failures as `Win32Exception`, named constants,
  handles closed in `finally`. PowerShell: `#Requires -Version 5.1`, `param()`, approved verbs, CRLF.
- `npm run lint` (ESLint, also the layer boundaries) and `npm run format:check` pass.

## Rules
- `npm run build` = tsc + esbuild bundle + schema generation. Commit changed `schemas/*.json`.
- `npm test` must end with the text `ALL TESTS PASSED`: gate on that text, not on the exit code. The live tests (ConPTY,
  daemon, git shim) can flake under load, so run once more before assuming a real failure.
- The self-test refuses to run outside a Windows Sandbox or GitHub Actions (`onThrowawayMachine` in
  `src/selftest/index.ts`). Never run it on a real PC.
- Inside a sandbox, commands that control the sandbox from outside (`launch`, `attach`, `exec`, `stop` ...) fail with a
  clear message (`requireOnPc`); `db` runs `dist/runtime/db.js` directly.
- Tests use only temp folders they create. Never the real `~/.agent-sandbox`, registry, PATH, profile or global git config.
- Messages are short, plain English with no jargon. Errors the user can act on use `fail(message, fix)`.
- The guest is hostile. Host code never executes guest data, never follows links under the data folder
  (`assertNoLinks`), keeps its own state outside it, validates everything read from `run/`, prints guest text through
  `safeText`, and reads workspace files with bounded effort (no unbounded regexes on them).
- A repo's `.sandbox-config.json` is untrusted: it needs a hash-based approval, and may only make protections stricter
  (`NEVER_LOOSER` in `core/local-config/overrides.ts`). Never add storage, executables, secrets or host folders to `LocalOverrides`.
- Host code must never import guest modules with side effects (`guest/runtime/session.ts` reads session.json and
  `runtime/log.ts` creates the logs folder on load). Pure helpers live in side-effect-free files (the allowlist above).
- Never spawn programs by bare name: use `SYSTEM.*` or absolute paths (cwd is often the workspace).
- New toolchain: a module, a step in `toolchains/plan.ts`, schema + `DEFAULTS` + `config.example.json`, markers in
  `toolchains/catalogue.ts` / `core/detect` for `auto`. Long-running work uses `execAsync` / async downloads so parallel steps keep going. Update docs.
- New setting or command: `core/schema/` / `cli/manifest.ts` first (flags, menu and JSON Schema follow), then docs. The self-test
  checks that `config.example.json` equals `DEFAULTS`.
- Several projects: the launch folder is the primary workspace. A project's guest path never depends on which project
  started the sandbox (git worktrees store absolute paths): inside a root it is `C:\Projects\<root>\<name>` (the launch
  folder too: the root shows it, no own mapping), otherwise `C:\Workspace\<name>` (launch, boot mapped, wsb shares),
  all decided in `shared/paths/projects.ts`. Anything that assumed ONE workspace must take the project from `ProjectSpec` / the registry.
  Toolchain steps read the project folder through `projectWorkspace()`, and with `duringSession()` must not change
  machine-wide state that running sessions use. Machine-wide protections are never loosened (`core/local-config/policy.ts`).
- C#: C# 5 only (the compiler that ships with Windows): every csc helper compiles with
  `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, every Add-Type file loads in powershell.exe 5.1.
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
`sbx-db` is `src/guest/entries/db.ts` with `guest/databases/sbx-db.ts` (bundled to `dist/runtime/db.js`). It reads
`session.json`: `databases` are the plans for this project, `databaseCatalog` lists every database it may start
later. `sandbox db` runs it directly inside a sandbox and through the exec channel from the PC; `--database <name>` adds plans at launch.

## Workflows
- In `release.yml` / `ci.yml`, a `pwsh` step ends with the exit code of its last native command. End steps with
  `exit 0` after native commands that may return non-zero on purpose (git rev-parse, npm view ...).
- CI also builds on the official Node 22.0.0 zip (setup-node's 22.0.0 has a broken npm). Releases run no tests.

## Releasing
Bump `version` in `package.json` and push to master; CI tags and publishes it. The first npm publish is done once from
the PC (`npm run publish:npm`). Full steps: [docs/development.md](docs/development.md#releases).
