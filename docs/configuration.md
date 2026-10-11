# Configuration

## Your settings

The easiest way: `sandbox`, then **Settings**. Every setting is listed by section with its current value and what it
does; pick one to change it (on/off and choices as lists) or reset it to the default. Changes are saved to your config
file, keeping its comments, and only when the result is valid.

`sandbox config init` creates `~/.agent-sandbox/config.json` with every setting and its default (see
[config.example.json](../config.example.json)). Keep only what you change. VS Code shows docs and autocomplete from
its JSON Schema. `sandbox config show` prints the effective config.

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
| `harnesses` | agents and how to install them |

## Paths

| Setting | Default | |
|---|---|---|
| `storage.root` | `%LOCALAPPDATA%\AgentSandbox` | everything on your PC |
| `storage.dataName` | `default` | the persistent data set (`C:\AgentData` inside); a different one per untrusted project keeps its tools separate |
| `guestWorkspace` | `C:\Workspace\<folder>` | where the project appears inside |
| `mappings` | none | more folders from your PC, read-only or read/write |

Under `storage.root`: `data\<name>` (tools, databases, logins, logs), `launches\` (one per start; cleaned after 7
days), `accounts\`, `sync\`.

## Project settings

A project can carry a `.sandbox-config.json` (see the [example](../.sandbox-config.example.json)) for its agent,
toolchains and versions, databases, git mode, extra folders and setup scripts. A repo can ship this file, so you
approve it the first time and whenever it changes. Risky settings are flagged, and it can never change storage,
executables, secrets handling or anything outside a safe list.

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
