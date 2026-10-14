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
| `toolchains.<lang>.enabled` | `true`, `false` or `"auto"` (only when the project uses it). Every tool is like this, Bun, uv and VS Code too, and a project's `.sandbox-config.json` can set it |
| `toolchains.<lang>.version` | default versions; project version files still win |
| `databases.<db>.enabled`, `.port` | `true`, `false` or `"auto"`, and the port inside |
| `sandbox.memoryMb`, `.headless`, `.vGpu`, `.networking` | RAM, no window, GPU, internet |
| `sandbox.pageFileMb` | size of the sandbox's paging file, created at full size at start so it never grows under load (default `16384`; `0` = Windows' own ~1 GB, which parallel builds run out of) |
| `sandbox.keepAwake` | keep this PC from sleeping while a sandbox runs (default `true`), so agents left overnight keep working. The screen may still turn off; closing a laptop lid still sleeps it |
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
| `toolchains.rust.linker`, `.linkSlots` | GNU host: `"lld"` (default, far less memory than GNU ld) or `"gnu"`, and how many programs may link at once in the whole sandbox (`"auto"` = one per 8 GB, 2 to 4) |
| `toolchains.cli.gh`, `.zstd`, `.openssl` | small command-line tools |
| `toolchains.mesa.enabled`, `.vulkan` | software OpenGL / Vulkan when there is no GPU |
| `harnesses` | agents and how to install them; `home` says where an agent keeps its login (variable -> folder in the saved state, the login files, the folder on this PC) so logins can be saved and switched |

## Paths

| Setting | Default | |
|---|---|---|
| `storage.root` | `%LOCALAPPDATA%\AgentSandbox` | everything on your PC. The name `AgentSandbox` is from before the rename and is kept on purpose, so existing users' data stays where it is |
| `storage.dataName` | `default` | the persistent data set (`C:\AgentData` inside); a different one per untrusted project keeps its tools separate |
| `guestWorkspace` | `C:\Workspace\<folder>` | where the project appears inside; `"mirror"` = the same path as on your PC (e.g. `F:\Projects\game`; falls back for `C:\Users\...`). Where projects appear with several projects: [projects](projects.md#where-a-project-appears-inside-the-sandbox) |
| `mappings` | none | more folders from your PC, read-only or read/write: `{ "host": "F:\\SteamLibrary\\steamapps\\common\\Game", "readOnly": true }`; `guest` (where it appears) is optional, `optional: true` skips a folder that is not on this PC |

Where a mapped folder appears:

- No `guest`: at the same path as on your PC (`C:\SteamGame` stays `C:\SteamGame`, `F:\SteamLibrary...` stays
  `F:\SteamLibrary...`). A folder inside the project is already in the sandbox with the project, so it needs no
  mapping (with `workspaceFilter` on, give it a `guest` path outside the project to bring a git-ignored folder in).
- `guest` given: exactly there. A full path: any `C:` folder, or any path on D: to Z:.
- A folder that cannot appear at its path stops the launch, and the message names each such folder, why, and the fix:
  a relative path, the folders the sandbox keeps for itself (`C:\Windows`, `C:\Program Files*`, `C:\ProgramData`,
  `C:\Users`, `C:\AgentData`, `C:\AgentLaunch`, `C:\HostTools`, `C:\nvm`, `C:\Mirror`), a path already used by the
  project, `C:\Projects` or another mapping (the same folder or one inside the other), a drive root, `A:`/`B:`, or a
  path Windows cannot have. Folders are never moved somewhere else. `sandbox config check` shows where each folder will
  appear, and any problem, before you launch.

Windows Sandbox can only map onto C:, so a guest path on F: is mapped to `C:\Mirror\F\...` and `subst F: C:\Mirror\F` runs at
boot. Tools that resolve real paths may print the `C:\Mirror` form; history sync understands both. A letter that already
exists in the sandbox is left alone.

Under `storage.root`: `data\<name>` (tools, databases, logins, logs), `launches\` (one per start; cleaned after 7
days), `accounts\`, `sync\`, `known-projects.json` (the folders you started projects in) and `run\projects.json` (the
running sandbox's projects). The last two are host-only: the sandbox cannot read or change them.

## Several projects in one sandbox

Starting an agent from another project while a sandbox runs adds that project to it: its own folder, `.sandbox-config.json`,
versions, toolchains, databases and environment. How that works, where each project appears inside the sandbox and the
consent prompts are in [projects](projects.md). These settings, in **your** config only (a project file can never set
them, because they map folders of your PC), decide which folders are already there:

| Setting | Default | |
|---|---|---|
| `projects.roots` | none | folders whose subfolders are your projects (e.g. `F:\Code`), mapped read/write at every start as `C:\Projects\<name>` (at their PC path with `guestWorkspace: "mirror"`). Every project inside, also one created later, opens without a restart, and is always under that folder (also when it started the sandbox) |
| `projects.all` | `false` | also map every project you have started before, at every start (`sandbox projects choose` / `all on`) |
| `projects.exclude` | none | projects left out of `all` |
| `projects.declinedRoots` | none | parent folders you said no to when asked to add them as roots (not asked again) |
| `projects.askToAddRoot` | `true` | when you start a project whose parent is not a root, ask once whether to add it (answers are saved: yes adds it, no is remembered in `projects.declinedRoots`, never turns this off) |
| `projects.allowOutsideMappings` | `"ask"` | may a project's `.sandbox-config.json` map folders outside the project (see [project settings](#project-settings))? `"ask"`, `true` or `false` |
| `projects.wsbShare` | `true` | on Windows 11 24H2+ with the updated Windows Sandbox, add other folders live with `wsb share` (untested; otherwise a restart is offered) |

## Network

The **Network** category of the settings (or `network` in your file):

| Setting | |
| --- | --- |
| `blockPrivateRanges` | your LAN (and SMB) is unreachable from the sandbox; DNS to the gateway still works (on by default) |
| `allowOnly` | only these hosts can be reached once the sandbox is set up (tools still download first). `*.example.com` covers its subdomains; `@developer` adds package registries, GitHub/GitLab, toolchain downloads and the AI providers. Programs go through a small proxy inside the sandbox (`HTTP_PROXY`, and the Windows proxy setting for browsers); everything else is blocked by the sandbox's firewall. Refused hosts are listed in `logs\netproxy.log` |
| `blockHosts` | names that go nowhere (the sandbox's hosts file), e.g. production servers or telemetry; exact names, no wildcards |
| `forwardPorts` | `{ "pc": 3000, "sandbox": 5173 }`: `http://localhost:3000` on your PC reaches port 5173 inside while the sandbox runs, even a dev server that only listens on localhost there. Only this PC can use it; no admin rights needed |
| `dns` | DNS servers for the sandbox, e.g. `["1.1.1.1", "9.9.9.9"]` |
| `proxy` | your HTTP proxy for everything in the sandbox (`HTTP_PROXY` / `HTTPS_PROXY`), e.g. `http://proxy.corp:8080`; with `allowOnly`, the sandbox's proxy hands on to it |

These are applied inside the sandbox, where the agent is an administrator: they keep a well-behaved agent (and the
tools it runs) in bounds, but a determined one could undo them. `sandbox.networking: false` is the only hard isolation.
A project's `.sandbox-config.json` may add `blockHosts` and turn on `blockPrivateRanges`, nothing else here.

## Audit log

`audit.enabled: true` (menu: Settings > Security & privacy > Audit log) keeps a log on your PC of what happened in your
sandboxes. It lives in `<storage>\audit\<data set>`, where the sandbox cannot reach it.

- **Programs started** in the sandbox, with their command lines (`audit.processes`): Windows' own process auditing,
  so it covers every agent and everything they start. Windows' background programs are left out.
- **Files changed** in the project while the sandbox runs (`audit.files`), seen from your PC.
- **Sessions** starting and ending, and what the **repo guard** caught.

It stays small: one short line per event, the same event within a minute is one line with a count, at most 300 lines a
minute (the rest is counted), finished days are compressed, and days past `audit.days` (14) or beyond `audit.maxMb`
(100 MB) are deleted, oldest first.

```powershell
sandbox audit                    # today
sandbox audit --days 7 --kind proc --grep "git push"
sandbox audit --json             # for scripts
```

What the sandbox reports about the programs it ran is taken as it says (an agent with admin rights there could leave
things out); file changes, sessions and repo-guard findings are observed from your PC.

## Git-ignored files

`workspaceFilter.enabled: true` keeps what your `.gitignore` lists out of the sandbox: `.env` files, your
`node_modules`, build output, local notes. The sandbox then works on a copy of the project (in
`<storage>\views\<project>`) that has only what git does not ignore, and the two are kept in step both ways while the
sandbox runs (changes arrive within about a second; a full check runs every minute and when the sandbox closes):

- Your edits reach the sandbox; the agent's edits, new files and deletions reach your project.
- What the sandbox creates that is ignored (its own `node_modules`, `target`, `dist` ...) stays in the copy, so it
  never mixes with what you build on your PC, and is there again next time.
- A file changed on both sides at once keeps yours; the sandbox's version is saved next to it as
  `<name>.sandbox-conflict-<time><ext>`.
- Git works as usual: the project's real `.git` is mapped next to the workspace (`C:\Workspace\<name>.git`), so commits
  and branches made in the sandbox are in your repository (and the repo guard still watches it). With git access
  `none` no `.git` is mapped at all.
- The rules are git's: every `.gitignore` in the project, `!` exceptions and `.git/info/exclude`.
  `workspaceFilter.exclude` keeps more out (`secrets/`, `*.pem`), `workspaceFilter.include` lets something in that
  git ignores (`.env.example`, `data/fixtures/`).

It applies to the folder you start from. Projects that join a running sandbox, and a project that is itself a git
worktree (its `.git` is a file), are mapped as they are. A project's `.sandbox-config.json` can turn the filter on and
add `exclude` patterns, never turn it off. `sandbox data clean views` removes the copies (your projects are not
touched).

## Project settings

A project can carry a `.sandbox-config.json` (see the [example](../.sandbox-config.example.json)) for its agent,
toolchains and versions, databases, git mode, extra folders and setup scripts. Check one without starting anything:
`sandbox config check`.

A repo can ship this file, so it is treated as untrusted:

- You approve it the first time, and again whenever it changes (the approval is tied to the file's exact contents).
- Read/write folders are flagged in the approval prompt, which is shown without colours or escape codes (a file cannot
  hide lines of it).
- Its extra folders (`mappings`) inside the project are fine. Folders outside it (decided after `%VARIABLES%` and links,
  so a link cannot hide one) follow `projects.allowOutsideMappings` in **your** settings: `"ask"` (the default) asks at
  an interactive launch, once per project file and folder, listing each folder, read-only or read/write, and where it
  will appear; a yes is kept in `<storage>\allowed-requests.json` (a no is not, so you are asked again). `true` allows
  them (still flagged "outside the project" when you approve the file), `false` refuses them. Without a terminal,
  `"ask"` stops the launch and says how to allow them; `--trust-config` never does. The launch table marks them
  "(outside the project, allowed)".
- It may add apps from the catalogue (`apps.install`, added to yours), never programs of its own (`apps.custom`).
- It can only make protections **stricter**: read-only, git `readonly`/`none`, the LAN block, protected client, and
  turning off network, clipboard, microphone, camera, printers, vGPU, login copying and history / claude-mem sync, and
  turning on `downloads.requireChecksum`. A looser value is used only if you allow it: starting the project from an
  interactive terminal asks once, in the same question as any folders outside the project ("Allow these for this
  project?"). Your answer is kept on this PC
  (`<storage>\allowed-requests.json`, which no repo or sandbox can write) for that project file only; `--trust-config`
  never allows one. Otherwise the launch names what was not used. Or set it in your own settings for every project.
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
