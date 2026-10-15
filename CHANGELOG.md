# Changelog

What shipped in each version, newest first. Planned work is in [docs/roadmap.md](docs/roadmap.md).

The command is `sandbox`. The old names `agent-sandbox`, `claude-sbx`, `codex-sbx` and `gemini-sbx` still work.
Some older names stay on purpose so that existing installs keep working: the `~/.agent-sandbox` folder, the
environment variables `AGENT_SANDBOX_HOME`, `AGENT_SANDBOX_CONFIG`, `AGENT_SANDBOX=1` and `AGENT_SANDBOX_WORKSPACE`, the
`agent-sandbox-quarantine` folder, and the Visual Studio instance ID that `vswhere` uses.

## 1.5.1

- An all-users install could not start a sandbox when your storage held many files: every launch rewrote folder
  permissions over everything inside it and stopped after two minutes with "Could not change the folder permissions
  ... ETIMEDOUT". A launch now writes only the entries that change, on those folders alone, and takes under a second.
- The installer no longer rewrites the permissions of `%ProgramData%\AgentSandbox` on every run when they are already
  right (that also walked every user's storage).

## 1.5.0

- The installer asks "Just me" or "Everyone on this PC", and installs side by side versions with a private Node.js and
  commands that read two pointer files. It replaces npm and 1.x installs, brings your settings up to date, and can be
  run with options or uninstalled (`-Uninstall`, `-RemoveData`). Releases list a `SHA256SUMS` file and the package
  carries its dependencies.
- `sandbox update` checks, installs, and rolls back versions, and `--auto on|off` switches automatic updates (a
  scheduled task for everyone, a daily check at command start for one user). The Maintenance tab has an Updates row.
- Other Windows users of an all-users install can use the sandbox you started when `sharing.otherUsers` is on:
  `status`, `sessions`, `attach`, `exec`, `db` work for them, `stop` needs the owner's name typed, and the rest is the
  owner's alone. Their own logins and agent environment are never sent into your sandbox.
- `sandbox migrate` brings your saved settings up to date after an upgrade, with a backup. A storage folder an old
  `config init` wrote into your config no longer overrides the shared folder of an all-users install.
- A new menu: the areas are tabs along the top, every command has its own screen, and Settings keeps unsaved changes
  until you save (Ctrl+S) or discard them.
- Saved logins for every agent, not just Claude: Codex, Gemini, OpenCode, Qwen, Copilot, Kilo, Amp, Cline, Continue,
  Kimi, Reasonix, CodeWhale, Aider and the rest. `sandbox accounts --agent <name>` and the Accounts tab.
- Any agent can join a running sandbox, from any project folder. When the sandbox lacks something the project needs:
  Restart (the open sessions come back and continue their conversations), Continue without it, or Cancel.
- `sandbox resume` reopens the sessions of the last sandbox, each in its own conversation. `resume.sessions` and
  `resume.restartAfterCrash` choose what happens after a crash or restart.
- Every boot tool can be `true`, `false` or `"auto"` (installed when the project uses it): Bun, uv, gh, pwsh, VS Code
  and the rest.
- Optional reverse-engineering tools in `apps.install`: REA (Reverse Engineer Anything), Ghidra, x64dbg, ILSpy,
  dnSpyEx, Detect It Easy, PE-bear, Cutter, radare2 and JADX.
- `sandbox host <agent>` runs an agent on this PC (not sandboxed) while your agent commands are forwarded to the
  sandbox.

## 1.4.3

- Rust builds on the GNU host link with lld, and only a few links run at once across the sandbox. This uses much less
  memory.
- Crash reports: the next launch says why the last sandbox ended. Reports are kept in `<storage>\logs\crashes` for
  crashes inside the sandbox and for this PC's blue screens.
- A memory log every 5 seconds while memory is high, and `memory-pressure.txt` (ok, high or critical) inside the sandbox.
- `claude` is on PATH in new terminal tabs. `py`, `pip` and `python3` work in Git Bash.

## 1.4.2

- Mapped folders appear where you asked: at the PC path or at the guest path you give.
- Joining a running sandbox asks first. A project that needs stricter settings is refused with the reason. A project
  that needs something the sandbox lacks gets Continue anyway, Restart with them, or Cancel.
- The background watcher never outlives the sandbox. The installer stops watchers left by older versions.

## 1.4.1

- A project's folders outside it (game installs and similar): `projects.allowOutsideMappings` ("ask", true or false).
  A guest path can be left out, and `sandbox config check` previews every folder.
- A project keeps the same path in the sandbox whichever project starts it, so git worktrees keep working.
- Joining a running sandbox that lacks what the project needs (vGPU, folders, memory) offers Continue anyway, Restart
  with them, or Cancel.
- First start: a heads-up with the download size, live progress, "still working" messages and "Ready in ...".
- Agent sessions: the mouse wheel and clicks reach the agent again, and split key sequences no longer leave stray letters.

## 1.4.0

Also contains 1.3, listed below.

- Audit log (optional): programs started in the sandbox, files changed, sessions and repo-guard findings. Kept for a set
  number of days and size-capped. Read it with `sandbox audit`.
- Containment without admin: programs and scripts the sandbox writes into a project get the "downloaded from the
  internet" mark (`storage.markSandboxFiles`). A warning when the persisted data passes `storage.warnDataGb`.
- Agents left overnight: the PC stays awake while a sandbox runs (`sandbox.keepAwake`). A warning when Windows Update
  waits to restart. The next launch says why the last sandbox ended.
- Windows inside the sandbox crashed under heavy parallel builds. Fixed with a fixed-size paging file
  (`sandbox.pageFileMb`), a memory log in `C:\AgentData\logs` (size-capped), and fewer cargo jobs per agent by default.
- A project's looser request (vGPU and similar) can be allowed once, for that project only. With vGPU, Vulkan runs on
  the GPU.
- The CPU cap and paging file helpers are small C# files with readable scripts around them.

### 1.3 (released inside 1.4.0)

- Git-ignored files and folders (node_modules, .env, build output) stay out of the sandbox (`workspaceFilter`). The
  sandbox works on a copy kept in step both ways, and the real `.git` is mapped beside it.
- A project asking for something only you can allow (vGPU and similar) is told at launch, with how to allow it.
- Rust: `CARGO_TARGET_DIR` per checkout, so git worktrees of several agents no longer share one target folder. GNU
  defaults that fit Windows (fewer jobs, line-table debug info).
- Git in the sandbox uses `core.autocrlf=input`, so checkouts made inside keep LF line endings.
- claude-mem keeps a few dated backups instead of replacing its only copy. The `py` launcher is next to `python`.
- Network settings: allow only some hosts (proxy and firewall), blocked hosts, the LAN block, DNS, an upstream proxy,
  and port forwarding from the PC into the sandbox.
- Security sweep: history syncs back for this project only, with no other projects' transcripts. Sandbox text is shown
  without escape codes everywhere. Attach connects only to the sandbox's own address.

## 1.2.0

- A full-screen menu (`sandbox` with no arguments): categories, search, command forms that show the live command line,
  and running sessions to attach to.
- A settings editor in the menu, with two tabs: All projects and This project. It shows value, default and source for
  each setting, and has editors for lists, maps, folders and agents.
- An apps catalogue of 60 apps and command-line tools, by category, installed portably. Your own programs can be added
  (`apps.custom`).
- VS Code set up for the sandbox's tools, with the extensions for the languages the project uses.
- Windows Terminal: new tabs open in the project folder.
- Agent sessions use Microsoft's newer pseudo console: no garbled screen after resizing, real scrollback, and late
  viewers get a replay.
- Security: the attach output filter was rewritten (it closed an OSC 52 clipboard bypass). Project files cannot map
  folders outside the project. The repo guard covers agent and editor files, submodules and more git keys.

## 1.1.0

- The sandbox's CPU is capped at 80 % by default, and its RAM share at 80 % by default.
- Several projects in one sandbox: join a running sandbox from another project folder, start several agents at once
  (`--session`), and restart to add projects when needed.
- Agent commands (Beta): typing `claude`, `codex` and similar on the PC starts them in a hidden sandbox.
- Command-line polish: progress lines, `NO_COLOR`, clearer prompts and option checks, and a global `--config`.
- `downloads.requireChecksum`. The installer refuses a release package with no listed SHA-256, unless
  `WDS_ALLOW_UNVERIFIED=1` is set.

## 1.0.5

- Databases start on demand: `sbx-db`, `sandbox db`, and `--database` at launch.
- Published to npm: the first version from the PC, then every release from CI.

## 1.0.4

- MSVC is installed without its installer, when `toolchains.msvc.acceptLicense` is on. PowerShell 7, command-line tools
  (`gh`, `zstd`, `openssl`), software Vulkan, and mirrored paths for game projects (`guestWorkspace: "mirror"`).
- The Node install uses a temp folder on the data disk, which fixes failed installs.

## 1.0.3

- A settings screen in the menu.
- `attach.auto` and `attach.autoHide` settings.

## 1.0.2

- Only what the project needs is installed: toolchains are detected from the project's files on the PC.
- `sandbox attach`, `sessions` and `status` also work inside a sandbox.
- Safer deletes: nothing can reach a profile, a drive or Windows.
- `sandbox claude` and `claude-sandbox` are the names to use; `claude-sbx` is the old name.

## 1.0.1

- Install commands that work, a short README with a docs folder, and CLAUDE.md for agents.
- `sandbox data` shows disk usage per drive.
- Fixes from review of the host and sandbox code, with fewer lookups at each boot.

## 1.0.0

- The first release of the npm package: a `sandbox` command with sessions, attach, toolchains, and sync of your Claude
  history between the sandbox and the PC.
