# agent-sandbox

Run **Claude Code** (or Codex / Gemini) inside **Windows Sandbox**, with the folder you are in as its workspace.
The agent gets a fully equipped Windows machine of its own, can read and write your project, and cannot touch
anything else on your PC. The sandbox is thrown away when it closes; your project, toolchains, logins and
conversation history are kept.

```powershell
cd C:\code\my-app
claude-sbx            # Claude, sandboxed, in Windows Terminal
claude-sbx -t         # ...or right here in your own terminal
```

## Install

You need Windows 10/11 **Pro, Enterprise or Education** and **Node.js 20+**.

```powershell
# 1. Enable Windows Sandbox once (admin PowerShell), then reboot
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All

# 2. Install (or update to) the latest release
npm install -g https://github.com/JoshDiDuca/agent-sandbox/releases/latest/download/agent-sandbox.tgz

# 3. Check everything is ready
agent-sandbox doctor
```

<details><summary>Other ways to install</summary>

```powershell
# a specific release
npm install -g https://github.com/JoshDiDuca/agent-sandbox/releases/download/v3.0.0/agent-sandbox-3.0.0.tgz

# straight from the repository (builds on install)
npm install -g github:JoshDiDuca/agent-sandbox

# from a local clone
npm install
npm install -g .

# from GitHub Packages (needs a GitHub token with read:packages in your ~/.npmrc)
npm install -g @joshdiduca/agent-sandbox --registry=https://npm.pkg.github.com
```
</details>

## Commands you will use

| Command | What it does |
|---|---|
| `claude-sbx` | Start Claude in a sandbox for the current folder (`codex-sbx`, `gemini-sbx` for the others) |
| `claude-sbx -t` | Same, but Claude runs in **this** terminal. Detach with `Ctrl+]`; Claude keeps running |
| `claude-sbx --headless` | No sandbox window at all (`sbx-show` brings it back) |
| `claude-sbx` *(again)* | While a sandbox runs: another Claude session, in a new tab |
| `claude-sbx --continue` | Anything agent-sandbox does not know goes straight to Claude |
| `sbx-show` | Show the window of a headless sandbox |
| `claude-host` | Claude on your PC, **not** sandboxed, with its own profile |

Everything else is `agent-sandbox <command>`:

```
launch [agent args]        start a sandbox (or another session in the running one)
attach [id]                show a running session in this terminal (Ctrl+] detaches)
sessions | status          what is running
exec -- <command>          run a command inside the sandbox and print its output
restart                    restart Claude in place; it resumes the conversation
stop | show | hide         shut down, show or hide the sandbox
account <action>           list | save <name> [--from-host] | use <name> | default <name> | remove <name>
sync                       copy history back to this PC now
logs [-f]                  the sandbox's log
clean [--days n]           delete old launch folders, logs and leftovers
config show|path|init|schema
doctor | self-test
```

Launch options: `-t/--terminal`, `--headless`, `--window`, `--account <name>`, `--node <ver>`, `--python <ver>`,
`--workspace <dir>`, `--harness <name>`, `--script <file>`, `--no-agent`, `--trust-config`, `--no-local-config`,
`--config <file>`. If Claude ever gains a flag with the same name, use the reserved spelling (`--sbx-terminal`,
`--sbx-headless`, ...) for ours, or put Claude's flags after `--`.

## What's in the sandbox

The first start downloads what it cannot copy from your PC (a few minutes, once). Everything lives in
`C:\AgentData`, which survives the wipe, so later starts take seconds.

| | |
|---|---|
| **Window** | Windows Terminal, maximised, with your desktop theme |
| **Git** | Full Git for Windows with Git Bash (copied from your PC when installed); your name/email only |
| **Node** | nvm-windows; `nvm use` / `nvm install` work. Default version: `--node` > `.sandbox-config.json` > `.nvmrc` / `.node-version` > your PC's version. Extra versions via config |
| **Python** | Python 3 with pip (`.python-version` respected) and Python 2.7 as `python2` / `pip2` |
| **Rust** | rustup, cargo, rustc (GNU host; `rust-toolchain.toml` respected) |
| **C / C++** | MinGW-w64 GCC: `gcc`, `g++`, `mingw32-make` (also Rust's linker) |
| **C# / .NET** | .NET SDK (LTS by default; a project's `global.json` is installed too) |
| **Bun, uv** | Both on PATH (claude-mem needs them) |
| **VS Code** | Portable, `code .` or the desktop shortcut; its settings and extensions persist |
| **Your Claude** | settings, CLAUDE.md, commands, agents, skills, plugins and MCP servers from your PC |
| **Your desktop** | theme, accent colour, taskbar, Explorer options, wallpaper, mouse/keyboard, date/number formats (an allow-list of registry values) |

Installs that persist: `npm i -g` (per Node version), `pip`, `cargo install`, `dotnet tool -g`, `uv tool`, `bun add -g`,
and anything portable in `C:\AgentData\tools\bin` (on PATH). Real installers (MSI, winget) need a hook script,
because everything outside `C:\AgentData` is wiped. Every agent gets a short manifest telling it exactly this.

## Your history and claude-mem

- **Conversations:** before each start, all your Claude conversations, prompt history, todos and plans are copied in.
  New history comes back every minute and when the sandbox closes. Paths are translated between your folder and
  `C:\Workspace\<name>`, so `--continue` / `--resume` work on both sides.
- **claude-mem:** the plugin and its data go in; its database comes back when the sandbox closes. If both sides
  changed, your PC's copy is kept as `.claude-mem.conflict-<time>` first, so nothing is lost.

## Several Claude accounts

```powershell
agent-sandbox account save personal          # the login currently in the sandbox
agent-sandbox account save work --from-host  # or this PC's login
agent-sandbox account default personal       # used for new sandboxes
agent-sandbox account use work               # switch now
```

`account use` swaps the login and restarts Claude in place with `--continue`, so the conversation carries on under
the other account. Claude cannot change accounts without a restart, so a reply that is still streaming at that
moment is lost (finished messages are kept, and an interrupted tool call is flagged for Claude to check). The
outgoing account's refreshed tokens are saved first, so switching back always works.

## Git access

Choose how much the agent may do with git (`provisioning.git.access`, per project in `.sandbox-config.json`):

| Mode | The agent can |
|---|---|
| `full` *(default)* | use git normally |
| `readonly` | `status`, `log`, `diff`, `show`, `blame` and listing branches/tags; no commit, push, checkout, reset, ... |
| `none` | not use git at all; the repository is invisible to git and Claude may not read `.git` |

## Configuration

`agent-sandbox config init` creates `~/.agent-sandbox/config.json` with every setting and its default (see
[config.example.json](config.example.json)); delete what you do not change. The file has a JSON Schema next to it,
so VS Code shows docs and autocomplete for every key.

A project can carry a `.sandbox-config.json` ([example](.sandbox-config.example.json)) to choose its agent, memory,
git mode, toolchain versions, extra folders and setup scripts. A repo can ship this file, so **you approve it** the
first time and whenever it changes; risky settings are flagged. It can never change storage, executables or anything
outside a safe list. Run `agent-sandbox config schema` once for editor help in these files too.

Your own hook scripts (`.ps1`, `.mjs`, `.cmd`) go in `~/.agent-sandbox/hooks/{pre-provision,pre-agent,post-agent}`.

## Safety

agent-sandbox treats the sandbox as hostile and your PC as precious:

- **Containment:** the agent writes only your project folder (and its own storage). Drive roots, your user profile,
  system folders and agent-sandbox's own folders are refused as workspaces. vGPU is off by default.
- **Network:** your LAN is blocked from inside the sandbox (DNS to the gateway excepted). For hard isolation set
  `sandbox.networking` to `false`.
- **Nothing runs on your PC:** host and sandbox talk through small JSON files; the sandbox can be asked to do four
  things (start a session, run a command, restart, ping) and everything it writes back is validated and size-capped.
  Host-side state lives outside the sandbox's reach, and junctions or symlinks the sandbox plants are never followed.
- **Coming back:** only data files return with history; claude-mem returns its database only (never settings or the
  pickle-based vector store); git hooks or dangerous git config (`core.fsmonitor`, `core.sshCommand`, filters, ...)
  added inside the sandbox are quarantined before your own git can run them. `agent-sandbox status` lists any.
- **Your terminal:** `--terminal` connects only into the sandbox's own Hyper-V network with a per-session token, and
  clipboard-writing escape sequences are stripped.
- **Inside the sandbox** the usual "Do you want to run this file?" and SmartScreen prompts are switched off. That only
  affects the disposable sandbox, never your PC.

Treat what the agent writes into your project like a contribution from a stranger: review it before you run it.

## Storage and cleanup

Everything lives under `storage.root` (default `%LOCALAPPDATA%\AgentSandbox`): `data\<name>` (tools, state, logs;
`C:\AgentData` in the sandbox), `launches\` (one folder per start), `accounts\`, `sync\`. Each launch deletes launch
folders older than 7 days, logs older than 14 days and interrupted downloads; `agent-sandbox clean` does it on demand.

## Troubleshooting

| Problem | Try |
|---|---|
| Anything | `agent-sandbox doctor`, then `agent-sandbox logs -f` |
| "A Windows Sandbox is already running" | Only one can run at a time: `agent-sandbox status`, then `sbx-show` or `agent-sandbox stop` |
| A toolchain failed on first boot | It is skipped, the rest still works; fix the network and set `provisioning.refresh` once |
| Config errors | The message names the key and the problem; `agent-sandbox config show` prints the effective config |

## Development

```powershell
npm install               # dependencies + build
npm test                  # offline, security and live ConPTY/daemon/git tests; ends with ALL TESTS PASSED
npm run release:patch     # bump the version and push a tag: GitHub Actions tests, packs and publishes a release
```

To also publish to npm: add an `NPM_TOKEN` repository secret and pick a package name you own (for example
`@you/agent-sandbox`). See [CLAUDE.md](CLAUDE.md) for the code layout.
