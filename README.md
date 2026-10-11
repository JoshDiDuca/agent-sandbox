# windows-development-sandbox

A disposable **Windows Sandbox** for development, with or without an AI agent. Run it in a project folder and you get
a clean Windows machine where that folder is the workspace, the languages, package managers and databases the project
uses install themselves, and nothing else on your PC is reachable. Close it and it is gone; your project, toolchains,
databases, logins and conversation history are kept for next time.

```powershell
cd C:\code\my-app
sandbox               # the menu: start an agent, a plain sandbox, diagnostics, cleanup, ...
claude-sbx            # Claude Code, sandboxed, in Windows Terminal (claude-sandbox works too)
claude-sbx -t         # ...or right here in your own terminal
sandbox start         # just the sandbox, no agent
sandbox opencode      # any configured agent by name
```

## Install

You need Windows 10/11 **Pro, Enterprise or Education** (Home has no Windows Sandbox). One line in PowerShell checks
your PC, offers to turn Windows Sandbox on and to install Node.js if needed, then installs everything:

```powershell
irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1 | iex
```

<details><summary>Other ways to install</summary>

```powershell
# 1. Windows Sandbox (admin PowerShell, then reboot) and Node.js 20+
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
# 2. The package (latest release, a specific one, or from GitHub)
npm install -g https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/windows-development-sandbox.tgz
npm install -g https://github.com/JoshDiDuca/windows-development-sandbox/releases/download/v1.0.0/windows-development-sandbox-1.0.0.tgz
npm install -g github:JoshDiDuca/windows-development-sandbox
# 3. Check
sandbox setup         # this PC: edition, virtualization, Windows Sandbox, RAM, disk, Node
sandbox doctor        # what will be copied from this PC or downloaded
```
Upgrading from the old `agent-sandbox` package: the installer (and `npm run install:global`) removes it first; your
storage, logins and config carry over.
</details>

The **first start downloads** what it cannot copy from your PC (a few minutes, once). Everything is kept in persistent
storage, so later starts reuse it and take seconds. Installers run in parallel, and the sandbox window and
`sandbox status` say what is being installed.

## Commands

`sandbox` with no arguments opens an **interactive menu**: the first entry repeats your last command, then start an
agent (it shows which ones are already installed), start a sandbox without an agent, sessions, data, diagnostics and
config. Every command asks for each option (on/off options as checkboxes) and shows the exact command line before it
runs, so you learn the typed form as you go. All commands also work directly:

| Command | What it does |
|---|---|
| `sandbox` | the menu |
| `claude-sbx` / `claude-sandbox` | Claude in a sandbox for this folder (`codex-*`, `gemini-*` likewise; `sandbox <agent>` for any agent) |
| `sandbox start` | the sandbox without an agent: toolchains, databases and a terminal |
| `claude-sbx -t` | in **this** terminal. Detach with `Ctrl+]`. In a running sandbox it reattaches to this folder's session when no terminal is attached to it (`--new` starts another) |
| `sandbox launch` | start an agent with every option (`--harness`, `--account`, `--headless`, `--node`, `--python`, `--script`, ...) |
| `sandbox attach [id]` / `sessions` | attach to a session / list sessions and who is attached |
| `sandbox status` / `exec -- <cmd>` | overview / run a command inside and print its output |
| `sandbox restart` / `stop` | restart agents in place (they resume their conversation) / shut down |
| `sandbox show` / `hide` (`sbx-show`, `sbx-hide`) | show or hide the Windows Sandbox window; hidden, it keeps running |
| `sandbox account ...` | Claude accounts: `list`, `save <name> [--from-host]`, `use`, `default`, `remove` |
| `sandbox data [show]` / `data clean <what>` | what persists (sizes per toolchain, database, login, logs) / delete parts of it |
| `sandbox setup` / `doctor` / `repair` | check this PC and offer fixes / what will be copied or downloaded / find and fix common problems |
| `sandbox generate` | dry run: writes the launch files and shows what would happen |
| `sandbox logs [-f]` / `clean` / `sync` | the sandbox log / delete old launch folders and logs / sync history back now |
| `sandbox config show\|path\|init\|schema` | effective config / its file / create it / editor schemas |
| `claude-host` | Claude on this PC, **not** sandboxed, with its own profile |

If an agent ever gains a flag with the same name as ours, use the reserved spelling (`--sbx-terminal`, ...) or put the
agent's flags after `--`.

## Agents

| Agent | Status | Installed from |
|---|---|---|
| **Claude Code** (`claude`) | tested | copied from this PC, else npm `@anthropic-ai/claude-code` |
| Codex (`codex`), Gemini (`gemini`) | supported | npm `@openai/codex`, `@google/gemini-cli` |
| opencode, Qwen Code (`qwen`), Crush, GitHub Copilot CLI (`copilot`), Kilo Code (`kilo`), Amp, Cline, Continue (`continue`), Kimi | untested | each project's official npm package |
| DeepSeek: Reasonix (`reasonix`), CodeWhale (`deepseek`) | untested | npm (DeepSeek has no official CLI; these are the community agents built for it) |
| Aider | untested | PyPI `aider-chat` via `uv tool install` |

Add your own under `harnesses` in the config (`npmPackage`/`npmBin`, `uvPackage`/`uvBin` or `hostExecutable`).
Restarting an agent in place resumes its conversation where the agent supports it (`resumeArguments`).

## Languages and tools

A toolchain set to `"auto"` is installed only when the project uses it (found from files like `go.mod`, `pom.xml` or
`Gemfile` in the workspace or one folder down). Project version files are respected. Everything installs once into
`C:\AgentData\tools` and is reused.

| | Status | What you get |
|---|---|---|
| **Node** | tested | nvm-windows; version from `--node` > `.sandbox-config.json` > `.nvmrc` / `.node-version` / Volta pin > your PC's. Up to 3 of your PC's nvm versions are copied. pnpm and yarn via corepack (`packageManager` respected), global npm packages from config |
| **Volta** | smoke-tested | when package.json has `"volta"` pins or your PC uses Volta: the pinned node/npm/pnpm/yarn come first |
| **Python** | tested | CPython 3 with pip (`.python-version`), Python 2.7 as `python2`, uv (`uv tool`, `uv python install`), pyenv-win when your PC uses pyenv |
| **Rust** | tested | rustup, cargo (GNU host, `rust-toolchain.toml`), extra components/targets/crates from config |
| **C / C++** | tested | MinGW-w64 GCC with CMake, Ninja, premake5, mingw32-make, win_flex/win_bison |
| **C# / .NET** | tested | .NET SDK (LTS + `global.json`), workloads and global tools from config, .NET Framework reference assemblies (net48, net472, ...) so net4x and old-style `.csproj` build without Visual Studio, optional .NET Framework 3.5 |
| Go | smoke-tested | go.dev release, `GOTOOLCHAIN=auto`, `go install` tools from config |
| Java | smoke-tested | Temurin JDK (`lts` or `.java-version` / `.sdkmanrc`), Maven, Gradle |
| Ruby | smoke-tested | RubyInstaller (`.ruby-version`), gems from config (C-extension gems need MSYS2, not included) |
| PHP | smoke-tested | windows.php.net build with common extensions, Composer, the Visual C++ runtime it needs |
| Deno, Bun | smoke-tested / tested | single binaries on PATH |
| Mesa 3D | smoke-tested | software OpenGL 4.5 for games and apps without a GPU (opt-in) |
| VS Code | tested | portable, `code .`; settings and extensions persist |

"Smoke-tested" means installed for real in a sandbox and each tool built or ran a small project; not yet used on a
real project. Installs that persist: `npm i -g` (per Node version), `pip`, `cargo install`, `dotnet tool -g`,
`uv tool`, `go install`, `gem install`. Real installers (MSI, winget) need a hook script, because everything outside
`C:\AgentData` is wiped.

**Mapped folders** (the workspace and `C:\AgentData`) allow no symlinks or junctions. The sandbox already sets pnpm to a
flat `node_modules`, keeps Bun's cache on the sandbox's own disk and turns off Gradle's file watching. npm workspaces
with `file:` links, Deno's `node_modules` mode and Bun lockfile saves still cannot work there; the agent is told.

## Databases

Like toolchains, each database defaults to `"auto"`: it runs only when the project needs it. That is worked out from
compose files (`image: postgres:16`), dependencies in every ecosystem (pg, psycopg, Npgsql, mongoose, ioredis, the
AWS DynamoDB SDKs, ...), Prisma and ORM config, infrastructure code (CloudFormation / SAM / Terraform tables),
connection strings and `.env` templates. An ORM that names no database uses the one installed on your PC. The launch
table says what was found and why. Data persists in `C:\AgentData\databases`; every server listens on localhost only.

| Database | Verified | Connect with |
|---|---|---|
| PostgreSQL (psql, pg_dump) | yes | `postgres://postgres@localhost:5432/postgres` (no password; a compose pin picks the major) |
| MySQL, as MariaDB | yes | `mysql://root@127.0.0.1:3306` (no password) |
| MongoDB with mongosh | yes | `mongodb://127.0.0.1:27017` |
| Redis | yes | `redis://127.0.0.1:6379` (community Windows build) |
| **DynamoDB Local** + **dynamodb-admin** | yes | `http://localhost:8000`; the web UI on <http://localhost:8001> browses and edits tables. AWS SDKs reach it automatically (`AWS_ENDPOINT_URL_DYNAMODB`, dummy credentials) |
| SQL Server | no | LocalDB cannot start inside Windows Sandbox (tested 2022 and 2025); a project that needs it gets a hint instead |

**Docker** cannot run inside Windows Sandbox (it has no nested virtualization), so compose projects use the native
databases above. Connecting the sandbox to your PC's Docker or WSL2 would give the agent control of your PC; it is
planned only as an explicit, clearly warned opt-in.

## What else is in the sandbox

| | |
|---|---|
| **Window** | Windows Terminal, maximised; `--headless` (or `sandbox hide` later) hides the sandbox window and it keeps running |
| **Your desktop** | theme, accent colour, taskbar, Explorer options, wallpaper, mouse/keyboard and date/number formats are copied in (an allow-list of registry values; `personalization.enabled`) |
| **Git** | Git for Windows with Git Bash (copied from your PC when installed); your name/email only; HTTPS works out of the box |
| **Your Claude** | settings, CLAUDE.md, commands, agents, skills, plugins and MCP servers, with credentials stripped (below) |
| **Prompts** | "Do you want to run this file?", SmartScreen and firewall pop-ups are off inside the disposable sandbox only |
| **Games** | Mesa (software OpenGL) or `sandbox.vGpu: true` for a GPU, audio out, game data from a mapped folder |

## Sessions and attaching

Each agent session has its own pseudo console that the sandbox's tabs and your own terminal can show at the same
time. Closing a tab, inside or on your PC, never stops a session; only the agent exiting does. Sessions know who is
really watching (closed terminals stop counting within seconds), so `claude-sbx -t` picks up the session you left and
`sandbox sessions` shows who is attached. Backspace and resizing behave as in a normal terminal.

## History, claude-mem and accounts

- **Conversations:** all your Claude conversations, prompt history, todos and plans are copied in before each start;
  new history comes back every minute and when the sandbox closes, with paths translated between your folder and
  `C:\Workspace\<name>`, so `--continue` / `--resume` work on both sides.
- **claude-mem:** the plugin and its data go in; its database comes back when the sandbox closes (a conflicting copy
  on your PC is kept as `.claude-mem.conflict-<time>` first).
- **Several Claude accounts:** `sandbox account save personal`, `... save work --from-host`, `... default personal`,
  `... use work` (swaps the login and restarts Claude in place with `--continue`).

## Secrets

Credentials stay on your PC. Everything copied in from your Claude settings is stripped first: `settings.json` `env`
and credential helpers (`apiKeyHelper`, `awsCredentialExport`, ...) and every MCP server's env, headers, URL and
arguments. Removed: AWS, Azure, Google Cloud, Cloudflare, hosting, CI, registries, payment, AI API keys, database URLs,
anything named `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `*_KEY`, `*PROD*`, and values that look like keys whatever they are
called. `secrets.allow` lets named variables through (`["AWS_REGION", "MY_APP_*"]`), `secrets.patterns` adds more; a
project file cannot weaken this. The launch table lists what was kept back, and warns about files in the workspace
that usually hold secrets (`.env`, `*.pem`, ...), which the agent can read because the whole folder is mapped.

## Git access

`provisioning.git.access` (per project in `.sandbox-config.json`): `full` (default) uses git normally; `readonly`
allows status/log/diff/show/blame only; `none` hides the repository from the agent entirely.

## Configuration

`sandbox config init` creates `~/.agent-sandbox/config.json` with every setting and its default
([config.example.json](config.example.json)); keep only what you change. A JSON Schema next to it gives VS Code docs
and autocomplete. Paths you can change: `storage.root` (where everything lives on your PC), `guestWorkspace` (where the
project appears inside, default `C:\Workspace\<folder>`) and `mappings` (more folders from your PC, read-only or not).

A project can carry a `.sandbox-config.json` ([example](.sandbox-config.example.json)) to choose its agent, git mode,
toolchains, versions, databases, extra folders and setup scripts. A repo can ship this file, so **you approve it**
the first time and whenever it changes; risky settings are flagged and it can never change storage, executables,
secrets handling or anything outside a safe list. Hook scripts (`.ps1`, `.mjs`, `.cmd`) go in
`~/.agent-sandbox/hooks/{pre-provision,pre-agent,post-agent}`.

## Data, diagnostics and repair

- `sandbox data` shows everything that persists between sandboxes with its size: each toolchain, each database,
  agent logins and state, logs, launch folders. `sandbox data clean tools/go databases logs` deletes parts of it
  (never while a sandbox runs; `all` asks you to type "all").
- `sandbox repair` checks for and fixes stale run state, interrupted downloads, half-installed toolchains, links
  planted in the data folder and broken caches, and tells you what needs you (config errors, Windows Sandbox off,
  an old global package).
- `sandbox setup` checks the PC itself; `sandbox doctor` shows what will be copied or downloaded.

## Safety

The sandbox is treated as hostile and your PC as precious:

- **Containment:** the agent writes only your project folder and its own storage. Drive roots, your user profile,
  system folders and this tool's own folders are refused as workspaces. vGPU is off by default.
- **Network:** your LAN is blocked from inside the sandbox (DNS to the gateway excepted); `sandbox.networking: false`
  is the only hard isolation.
- **Nothing runs on your PC:** host and sandbox talk through small JSON files; the sandbox can ask for four things
  (start a session, run a command, restart, ping) and everything it writes back is validated and size-capped. Text from
  the sandbox is stripped of escape sequences before it reaches your terminal. Links the sandbox plants are never
  followed, files it writes are read with bounded effort, and host-side state lives outside its reach.
- **Coming back:** only data files return with history; claude-mem returns its database only; git hooks or dangerous
  git config added inside the sandbox are quarantined before your own git can run them (`sandbox status` lists any).
- **Your terminal:** attaching connects only into the sandbox's Hyper-V network with a per-session token.
- **Shared tools:** `C:\AgentData` (tools, databases) is shared by every project's sandbox. For an untrusted repo, give
  it its own data set: `storage.dataName` in your config, or `--config` with a different one.

Treat what the agent writes into your project like a contribution from a stranger: review it before you run it.

## Storage

Everything lives under `storage.root` (default `%LOCALAPPDATA%\AgentSandbox`): `data\<name>` (tools, databases, state,
logs; `C:\AgentData` in the sandbox), `launches\` (one folder per start), `accounts\`, `sync\`. Each launch deletes
launch folders older than 7 days, logs older than 14 days and interrupted downloads.

## Troubleshooting

| Problem | Try |
|---|---|
| Anything | `sandbox repair`, then `sandbox doctor` and `sandbox logs -f` |
| "Windows Sandbox is not available" | `sandbox setup` (checks edition and virtualization and offers to turn it on) |
| "A Windows Sandbox is already running" | Only one can run at a time: `sandbox status`, then `sbx-show` or `sandbox stop` |
| A toolchain failed on first boot | It is skipped and the rest works; `sandbox repair` removes a half-install so the next start retries |
| Disk filling up | `sandbox data` shows what is big; `sandbox data clean <part>` |
| Config errors | The message names the key and the problem; `sandbox config show` prints the effective config |

## Development

```powershell
npm install               # dependencies + build
npm test                  # offline, security and live ConPTY/daemon/git tests; ends with ALL TESTS PASSED
npm run install:global    # install this checkout globally as a COPY, so you can run claude-sbx inside the repo
npm run release:patch     # bump the version and push a tag: CI tests, packs and publishes a release with install.ps1
```

To develop this tool with an agent in its own sandbox, install it as a copy (`npm run install:global`), not with
`npm install -g .`: a linked install would let the sandboxed agent edit the code your PC runs. See
[CLAUDE.md](CLAUDE.md) for the code layout.
