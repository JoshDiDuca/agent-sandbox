# Configuration

## Your settings

The easiest way: `sandbox`, then **Settings**. Every setting is listed by section with its current value and what it
does; pick one to change it (on/off and choices as lists) or reset it to the default. Changes are saved to your config
file, keeping its comments, and only when the result is valid.

`sandbox config init` creates `~/.agent-sandbox/config.json` with every setting and its default (see
[config.example.json](../config.example.json)). Keep only what you change. VS Code shows docs and autocomplete from
its JSON Schema (`sandbox config schema` prints the setting that turns it on). `sandbox config show` prints your
settings with the defaults filled in. Comments and trailing commas are allowed in the file. Use another file with
`--config <file>` or `AGENT_SANDBOX_CONFIG`.

Commonly changed:

| Setting | |
|---|---|
| `defaultHarness` | the agent `sandbox launch` starts |
| `toolchains.<lang>.enabled` | `true`, `false` or `"auto"` (only when the project uses it) |
| `toolchains.<lang>.version` | default versions; project version files still win |
| `databases.<db>.enabled`, `.port` | `true`, `false` or `"auto"`, and the port inside |
| `sandbox.memoryMb`, `.headless`, `.vGpu`, `.networking` | RAM, no window, GPU, internet |
| `sandbox.cpuLimit` | most of your PC's CPU the sandbox may use, in percent (default `80`; `"none"` = all of it). Your setting only: a project file cannot change it |
| `sandbox.maxMemoryPercent`, `.maxMemoryMb`, `.reserveHostMb` | `memoryMb: "auto"` = free RAM minus `reserveHostMb` (8 GB), at most `maxMemoryPercent` (80) of your RAM and `maxMemoryMb` |
| `attach.auto` | starting an agent attaches this terminal automatically (like `-t`) |
| `agentCommands.enabled` | **(Beta)** typing `claude`, `codex` ... on this PC starts the agent in a hidden sandbox and attaches (default off) |
| `agentCommands.agents` | `"auto"` = every agent installed on this PC, or a list such as `["claude", "codex"]` |
| `attach.autoHide` | the sandbox window hides whenever this terminal attaches (`sandbox show` brings it back) |
| `provisioning.git.access` | `full`, `readonly` or `none` |
| `secrets.allow`, `secrets.patterns` | let named variables through, or strip more |
| `downloads.requireChecksum` | `true` refuses toolchain, database and tool downloads that have no published checksum (default `false`; downloads that have one are always verified) |
| `toolchains.environment` | extra environment variables (e.g. registry mirrors) |
| `toolchains.msvc.acceptLicense` | `true` to allow installing MSVC (see [toolchains](toolchains.md#msvc)) |
| `toolchains.rust.host`, `.targetDir`, `.crates` | Rust target (`auto`, msvc or gnu), where builds go, and binaries to install with cargo |
| `toolchains.cli.gh`, `.zstd`, `.openssl` | small command-line tools |
| `toolchains.mesa.enabled`, `.vulkan` | software OpenGL / Vulkan when there is no GPU |
| `harnesses` | agents and how to install them |

## Paths

| Setting | Default | |
|---|---|---|
| `storage.root` | `%LOCALAPPDATA%\AgentSandbox` | everything on your PC |
| `storage.dataName` | `default` | the persistent data set (`C:\AgentData` inside); a different one per untrusted project keeps its tools separate |
| `guestWorkspace` | `C:\Workspace\<folder>` | where the project appears inside; `"mirror"` = the same path as on your PC (e.g. `F:\Projects\game`; falls back for `C:\Users\...`) |
| `mappings` | none | more folders from your PC, read-only or read/write; `guest` may be on D: to Z: (e.g. `F:\SteamLibrary\...`) |

Windows Sandbox can only map onto C:, so a guest path on F: is mapped to `C:\Mirror\F\...` and `subst F: C:\Mirror\F` runs at
boot. Tools that resolve real paths may print the `C:\Mirror` form; history sync understands both. A letter that already
exists in the sandbox is left alone.

Under `storage.root`: `data\<name>` (tools, databases, logins, logs), `launches\` (one per start; cleaned after 7
days), `accounts\`, `sync\`, `known-projects.json` (the folders you started projects in) and `run\projects.json` (the
running sandbox's projects). The last two are host-only: the sandbox cannot read or change them.

## Several projects in one sandbox

Only one Windows Sandbox runs at a time, and it fixes its mapped folders when it starts. Starting an agent from another
project while it runs adds that project to it (see [commands](commands.md#several-projects)): its folder, its
`.sandbox-config.json`, versions, toolchains and databases (set up on demand; tools already installed cost nothing) and
its own environment for its sessions. These settings, in **your** config only (a project file can never set them,
because they map folders of your PC), decide which folders are already there:

| Setting | Default | |
|---|---|---|
| `projects.roots` | none | folders whose subfolders are your projects (e.g. `F:\Code`), mapped read/write at every start as `C:\Projects\<name>` (at their PC path with `guestWorkspace: "mirror"`). Every project inside, also one created later, opens without a restart |
| `projects.all` | `false` | also map every project you have started before, at every start (`sandbox projects choose` / `all on`) |
| `projects.exclude` | none | projects left out of `all` |
| `projects.askToAddRoot` | `true` | when you start a project whose parent is not a root, ask once whether to add it (answers are saved: yes adds it, no is remembered in `projects.declinedRoots`, never turns this off) |
| `projects.wsbShare` | `true` | on Windows 11 24H2+ with the updated Windows Sandbox, add other folders live with `wsb share` (untested; otherwise a restart is offered) |

Other projects appear under `C:\Projects`. Machine-wide protections were fixed when the sandbox started: a project
that needs a stricter one (git access, network, the LAN block, read-only, ...) cannot join and says so; one that asks
for less simply gets the sandbox's stricter value. Every agent in the sandbox can see every mapped project
([security](security.md#several-projects)). Each mapped folder passes the same checks as a launch folder (no drives,
your profile, system or tool folders).

Adding a folder to a RUNNING sandbox needs Windows 11 24H2+ with the updated Windows Sandbox (`wsb share`, untested).
On older Windows: folders inside a project root open instantly; anything else offers a restart. To get `wsb`:
Settings > Windows Update ("Get the latest updates as soon as they're available") or the Windows 11 Installation
Assistant, then update Windows Sandbox from the Microsoft Store; check with `wsb --version`.

## Project settings

A project can carry a `.sandbox-config.json` (see the [example](../.sandbox-config.example.json)) for its agent,
toolchains and versions, databases, git mode, extra folders and setup scripts. Check one without starting anything:
`sandbox config check`.

A repo can ship this file, so it is treated as untrusted:

- You approve it the first time, and again whenever it changes (the approval is tied to the file's exact contents).
- Read/write folders are flagged in the approval prompt.
- It can only make protections **stricter**: read-only, git `readonly`/`none`, the LAN block, protected client, and
  turning off network, clipboard, microphone, camera, printers, vGPU and login copying, and turning on
  `downloads.requireChecksum`. Looser values are ignored.
- It can never change storage, agent executables, secrets handling or any host folder used for tools or Claude settings.

## Accounts

```powershell
sandbox account save personal          # the login currently in the sandbox
sandbox account save work --from-host  # or this PC's login
sandbox account default personal       # for new sandboxes
sandbox account use work               # switch now: Claude restarts and continues the conversation
```

## Hooks

`.ps1`, `.mjs` or `.cmd` files in `~/.agent-sandbox/hooks/pre-provision`, `pre-agent` or `post-agent` run inside the
sandbox at that point, in name order. Use them for real installers, which must run again each boot.

## Agent commands (Beta)

`sandbox agent-commands on` (or `agentCommands.enabled` in the settings screen) makes the agents installed on this PC
start in the sandbox: type `claude` (or `codex`, `gemini` ...) in any project folder and it starts in a hidden sandbox
for that folder and attaches your terminal, exactly like `sandbox claude -t --headless`. Arguments go to the agent.

- It finds the agents on your PATH and writes a small forwarding command for each into `<storage>\agent-commands`, then
  puts that one folder first on **your** PATH (nothing else in PATH changes). Open a new terminal afterwards.
- `set SANDBOX_AGENT_DIRECT=1` (PowerShell: `$env:SANDBOX_AGENT_DIRECT=1`) runs the real agent on this PC instead.
- `sandbox agent-commands off` removes the commands and that PATH entry again. `status` shows what is forwarded.
- Agents installed later are picked up the next time you launch. An agent on the machine-wide PATH, not yours, is not
  overridden. Beta: it may have rough edges; it is off by default.

## CPU, RAM and GPU

Windows Sandbox has no CPU setting and would use every processor, so the sandbox caps itself: before anything starts,
its first window joins a Windows job object with a hard CPU-rate cap (`sandbox.cpuLimit`, default 80 %), and
everything this tool starts in it inherits that (agents, installs, builds, its terminal tabs). Programs started from the
sandbox's own Start menu are not covered. RAM is fixed when the sandbox starts (`memoryMb`, or "auto" within the limits
above). The GPU cannot be limited: Windows Sandbox only has it on or off (`sandbox.vGpu`, off by default).
