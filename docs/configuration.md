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
| `attach.auto` | starting an agent attaches this terminal automatically (like `-t`) |
| `attach.autoHide` | the sandbox window hides whenever this terminal attaches (`sandbox show` brings it back) |
| `provisioning.git.access` | `full`, `readonly` or `none` |
| `secrets.allow`, `secrets.patterns` | let named variables through, or strip more |
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
days), `accounts\`, `sync\`.

## Project settings

A project can carry a `.sandbox-config.json` (see the [example](../.sandbox-config.example.json)) for its agent,
toolchains and versions, databases, git mode, extra folders and setup scripts. Check one without starting anything:
`sandbox config check`.

A repo can ship this file, so it is treated as untrusted:

- You approve it the first time, and again whenever it changes (the approval is tied to the file's exact contents).
- Read/write folders are flagged in the approval prompt.
- It can only make protections **stricter**: read-only, git `readonly`/`none`, the LAN block, protected client, and
  turning off network, clipboard, microphone, camera, printers, vGPU and login copying. Looser values are ignored.
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
