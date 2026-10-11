# agent-sandbox

Run **Claude Code** (or Codex / Gemini) inside **Windows Sandbox**, with the folder you are in as its workspace.
The agent can read and write that folder and nothing else on your PC. The sandbox is wiped when it closes; your
project, toolchains, logins and history are kept.

- One command: `claude-sbx` in any project folder.
- Windows Terminal inside the sandbox, with Git (+ Bash), nvm/Node, Python 3 + 2, Rust, C/C++ (MinGW), .NET, Bun and uv ready.
- Use the sandboxed Claude **from your own terminal** (`claude-sbx --terminal`), or run the sandbox **headless**.
- Several Claude sessions in one sandbox, several Claude **accounts** you can switch between mid-session.
- Your conversation history and claude-mem data go in and come back out. Your desktop theme comes along too.

## Requirements

- Windows 10/11 Pro, Enterprise or Education with Windows Sandbox enabled. If it isn't, run this in an
  admin PowerShell and reboot: `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`
- Node.js 20 or newer on your PC.

## Install

```powershell
# from a GitHub release (no build needed)
npm install -g https://github.com/joshdiduca/agent-sandbox/releases/download/v3.0.0/agent-sandbox-3.0.0.tgz

# or from a clone of this repo
npm install          # also builds
npm install -g .

# or, once published to npm
npm install -g agent-sandbox
```

That gives you these commands:

| Command | What it does |
|---|---|
| `claude-sbx` | Start Claude in a sandbox for the current folder (`codex-sbx`, `gemini-sbx` for the others) |
| `claude-sbx --terminal` | Same, but Claude runs in **this** terminal (attaches if a sandbox is already running) |
| `sbx-show` | Show the window of a headless sandbox |
| `agent-sandbox ...` | Everything else (below) |
| `claude-host` | Claude on your PC, *not* sandboxed, with a separate profile |

## Use it

```powershell
cd C:\code\my-app
claude-sbx                     # sandbox window opens, Claude starts in C:\Workspace\my-app
claude-sbx --terminal          # ...or use it right here (Ctrl+] detaches, Claude keeps running)
claude-sbx --headless          # no window at all; sbx-show brings it back
claude-sbx --continue          # anything agent-sandbox doesn't know goes to Claude
claude-sbx                     # again while a sandbox runs: a second Claude session in a new tab
```

The first start downloads the toolchains (a few minutes, once). After that, a sandbox is up in seconds.

### All commands

```
agent-sandbox launch            start a sandbox (or another session in the running one)
agent-sandbox attach [id]       show a running session in this terminal (Ctrl+] detaches)
agent-sandbox sessions          list sessions                 agent-sandbox status      overview
agent-sandbox exec -- <cmd>     run a command inside the sandbox and print its output
agent-sandbox restart           restart Claude in place (it resumes the conversation)
agent-sandbox stop              shut the sandbox down         agent-sandbox show | hide
agent-sandbox account ...       list | save <name> [--from-host] | use <name> | default <name> | remove <name>
agent-sandbox sync              copy history back now         agent-sandbox logs [-f]
agent-sandbox clean [--days n]  prune old launches/logs       agent-sandbox doctor
agent-sandbox config init|show|path                           agent-sandbox self-test
```

Options: `--terminal`, `--headless` / `--window`, `--account <name>`, `--node <ver>`, `--python <ver>`,
`--workspace <dir>`, `--harness <name>`, `--script <file>`, `--no-agent`, `--trust-config`, `--no-local-config`,
`--config <file>`, `--json`.

## Accounts

```powershell
agent-sandbox account save personal      # saves the login currently in the sandbox
agent-sandbox account save work --from-host
agent-sandbox account default personal   # used for new sandboxes
agent-sandbox account use work           # switch now: Claude restarts with --continue and carries on
```

Claude refreshes its tokens while it runs, so switching away from an account saves its latest tokens first.

## Toolchains and versions

Everything is installed into `C:\AgentData\tools`, which survives sandbox wipes.

| Tool | Version comes from (first match wins) |
|---|---|
| Node (nvm-windows) | `--node`, `.sandbox-config.json`, `.nvmrc` / `.node-version`, config, the Node on your PC |
| Python 3 (+ `python2`) | `--python`, `.sandbox-config.json`, `.python-version`, config (latest 3.x) |
| Rust | `rust-toolchain.toml` (rustup handles it), config (`stable`, GNU host, linked with MinGW) |
| .NET SDK | `global.json`, config channels (`LTS`) |
| Git for Windows | copied from your PC if installed, otherwise PortableGit |

Inside the sandbox `nvm use 18` / `nvm install 22` work as usual. `npm i -g`, `pip`, `cargo install`, `dotnet tool -g`,
`uv tool` and `bun add -g` all install somewhere persistent. Portable programs can go in `C:\AgentData\tools\bin`
(it's on PATH). Every agent also gets a short manifest telling it what persists and where things are.

## History, claude-mem and your desktop

- **History:** before each start, all your Claude conversations, prompt history, todos and plans are copied in. New
  history is copied back every minute and when the sandbox closes. Paths are translated between your folder and
  `C:\Workspace\<name>`, so `--continue` / `--resume` work on both sides. Only data files come back, nothing executable.
- **claude-mem:** your plugin and `~/.claude-mem` data go in. Changes come back when the sandbox closes. If both
  sides changed, nothing is overwritten: the older copy is kept next to it as `.claude-mem.conflict-<time>`.
- **Desktop:** theme, accent colour, taskbar, Explorer options, wallpaper, mouse/keyboard and date formats are
  copied from your registry (an allow-list, nothing else).

## Configuration

Your settings live in `~/.agent-sandbox/config.json` (`agent-sandbox config init` creates it from
[config.example.json](config.example.json)). Keep only the keys you change. Your own hook scripts go in
`~/.agent-sandbox/hooks/{pre-provision,pre-agent,post-agent}`.

A project can carry `.sandbox-config.json` ([example](.sandbox-config.example.json)) to pick its agent, memory,
toolchain versions, extra folders and setup scripts. A repo can ship this file, so **you approve it** the first time
and whenever it changes. Risky items (read/write folders, copying your login, turning off the LAN block) are flagged.
It can never change storage paths, executables or anything outside a safe list.

## Safety

- The agent can write only to the workspace folder (plus its own persistent storage). Drive roots, your user profile,
  system folders and agent-sandbox's own folders are refused as workspaces.
- Your LAN is blocked from the sandbox by its firewall (DNS to the gateway excepted). For a hard guarantee, set
  `sandbox.networking: false`.
- Host and sandbox talk only through small JSON files. The sandbox can be asked to do exactly four things
  (start a session, run a command, restart, ping). Everything it writes back is size-capped and validated. Your PC
  never runs anything the sandbox sends.
- `--terminal` only connects to addresses inside the sandbox's own Hyper-V network, with a random token per session.

## Storage and cleanup

Everything lives under `storage.root` (default `%LOCALAPPDATA%\AgentSandbox`):
`data\<name>` (tools, state, logs; mapped to `C:\AgentData`), `launches\` (one folder per start), `accounts\`.
Every launch deletes launch folders older than 7 days, logs older than 14 days and interrupted downloads.
`agent-sandbox clean` does the same on demand.

## Troubleshooting

- `agent-sandbox doctor`: checks Windows Sandbox, RAM and what will be copied or downloaded.
- `agent-sandbox logs -f`: follow the sandbox's log. All logs are in `<storage>\data\<name>\logs`.
- Sandbox won't start? Only one Windows Sandbox can run at a time: `agent-sandbox status`, then `sbx-show` or `stop`.

## Development

```powershell
npm install        # installs deps and builds
npm test           # offline tests + live ConPTY/daemon tests; must end with ALL TESTS PASSED
npm run release:patch   # bumps the version and pushes a tag -> GitHub Actions builds, tests and publishes a release
```

Publishing to npm: add an `NPM_TOKEN` secret to the repository, and pick a package name you own (e.g. a scoped
`@you/agent-sandbox`) in `package.json`. The release workflow then publishes every tagged version.
See [CLAUDE.md](CLAUDE.md) for the code layout.
