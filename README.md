# agent-sandbox

Runs Claude Code (or Codex / Gemini) inside Windows Sandbox with **the folder you run it from** as the workspace.
TypeScript source is in `src/`; compiled JavaScript is already in `dist/`, so there is nothing to build. You need Node 20+ on your PC.

## Quick start (Windows 11 Pro/Enterprise/Education)

```powershell
cd C:\Scripts\agent-sandbox
node dist\index.js self-test        # offline logic tests, must say ALL TESTS PASSED
node dist\index.js doctor           # shows what will be copied / installed
node dist\index.js install-commands # adds claude-sbx, codex-sbx, gemini-sbx, claude-host to PATH (open a new terminal)

cd C:\any\project\folder
claude-sbx                          # that folder is C:\Workspace (read/write) and Claude starts in it
```

Without the wrappers: `node C:\Scripts\agent-sandbox\dist\index.js launch` from the project folder.
The agent can read/write the current folder and nothing else on your PC (plus whatever you map in config, read-only by default).
If Windows Sandbox is not enabled: elevated PowerShell, `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`, then reboot.

## Where settings come from

Lowest to highest priority:

1. Built-in defaults.
2. `config.json` next to the tool: your defaults for every folder (agent, memory, network, mappings, Claude settings, ...).
3. `--project <name>`: optional named preset from `config.json` -> `projects` (legacy; not needed).
4. `.sandbox-config.json` in the folder you run from (see below).
5. Command-line flags (`--harness`, `--workspace`, `--script`, ...).

## Per-folder settings: `.sandbox-config.json`

Put this file in a project folder to change settings for that project only. Every key is optional; relative paths are relative to the file. See `.sandbox-config.example.json`.

```json
{
  "harness": "claude",
  "sandbox": { "memoryMb": 16384, "networking": true },
  "mappings": [
    { "host": "F:\\SteamLibrary\\steamapps\\common\\Call of Duty Modern Warfare 2", "guest": "C:\\GameSources\\MW2", "readOnly": true, "optional": true }
  ],
  "scripts": ["./sandbox-setup.ps1"]
}
```

Allowed keys: `harness`, `guestWorkspace`, `readOnly`, `mappings`, `scripts`, `sandbox.*`, `network.blockPrivateRanges`, `provisioning.copyFromHost|fallbackToInstall|refresh|git|terminal|node.version`, `claudeProfile.enabled|include|overwrite|copyCredentials`, `hooks.failFast`. Anything else (storage, agent executables, host Node/Claude folders, other host paths) is rejected.

**A repo can ship this file, so it must be approved.** The first time (and whenever the file changes) the tool lists exactly what it would change, highlights risky items (read/write mappings, copying your Claude login, turning off the LAN block) and asks `[y/N]`. Approvals are stored by file path + SHA-256 in `<storage.root>\trusted-configs.json`. Non-interactive runs fail unless you pass `--trust-config`. Use `--no-local-config` to ignore the file.

## Workspace safety

The workspace must exist and is refused if it is a drive root, your whole user profile, the agent-sandbox install folder (or inside it, or a parent of it), the storage folder, or a system folder (Windows, Program Files, ProgramData). This stops the agent from being able to modify the tool that launches it.

## What happens when it starts

1. The host writes a `.wsb` plus a launch folder and starts Windows Sandbox.
2. Windows runs `sandbox\logon.cmd` (hidden), which writes `C:\AgentData\logs\logon-hit.txt` and opens a visible PowerShell running `bootstrap.ps1`.
3. `bootstrap.ps1` makes sure Node exists in persistent storage (copy from your PC, or download) and runs `guest\main.js`.
4. `main.js` applies the private-network block, runs hooks, sets up Git, gets the agent, copies your Claude settings, then starts the agent in `C:\Workspace`.

Persistent storage is `<storage.root>\data\<storage.dataName>` (mapped to `C:\AgentData`): Node, the agent, Git, logins/state, logs. It is shared by every workspace, so you only sign in and download once. (`storage.dataName` in `config.json` defaults to `default`; yours is set to `mw2-agent` so the existing cache keeps working.)

## Copy from your PC vs install (`config.json` -> `provisioning`)

| setting | meaning |
|---|---|
| `copyFromHost: true` | Node is copied from your PC's Node folder; Claude from `claude.exe` on PATH or `~\.local\bin`. Those folders are mapped read-only. |
| `copyFromHost: false` | Nothing is copied: Node is downloaded (SHA-256 verified) and the agent is installed with npm inside the sandbox. |
| `fallbackToInstall: true` | If a host copy is missing, install instead of failing. |
| `refresh: true` | Re-copy / re-install even if cached. |

## Claude settings

Before each launch `settings.json`, `CLAUDE.md`, `commands`, `agents`, `skills` and your `.claude.json` are copied from your PC into the sandbox profile (history is never copied or mapped; malformed JSON is skipped with a message). Your login is **not** copied unless `claudeProfile.copyCredentials` is true.

## Hooks

Put `.ps1`, `.mjs` or `.cmd` files in `hooks\pre-provision`, `hooks\pre-agent` or `hooks\post-agent` (name order), or use `--script <file>` / `"scripts"` in `.sandbox-config.json`. They run inside the sandbox in the workspace with `AGENT_WORKSPACE`, `AGENT_DATA`, `AGENT_TOOLS`, `AGENT_PROJECT` set.

## Commands and options

`launch`, `generate` (no start), `doctor`, `host-claude` (Claude on your PC, not sandboxed), `install-commands [--shadow]`, `self-test`.
Options: `--workspace <dir>`, `--harness <name>`, `--project <name>`, `--script <file>`, `--no-agent`, `--trust-config`, `--no-local-config`, `--config <file>`, and `-- <args>` passed to the agent (e.g. `claude-sbx -- --continue`). `--here` is accepted and ignored (the current folder is always the default).
The `claude-sbx` / `codex-sbx` / `gemini-sbx` wrappers force their agent, overriding `harness` in config files.

## Network

`network.blockPrivateRanges` blocks 10/8, 172.16/12, 192.168/16, 169.254/16, multicast, IPv6 local and SMB with guest firewall rules (via `netsh`); only DNS/DHCP to the sandbox gateway stays open. If the internet stops working afterwards the rules are removed and a warning is printed. This is guest-enforced, so an agent with admin rights could undo it. `sandbox.networking: false` is the only hard guarantee Windows Sandbox offers.

## Troubleshooting

Logs: `<storage.root>\data\<dataName>\logs\` - `logon-hit.txt` (Windows ran the logon command), `bootstrap-*.log` / `bootstrap-error.txt` (Node stage), `guest-*.log` / `guest-error.txt` (hooks, Git, agent). The sandbox window prints failures in red and stays open.

## What was and was not verified

`self-test` checks (offline): config loading, run-from-any-folder, workspace safety refusals, `.sandbox-config.json` validation/trust/precedence, presets, `.wsb` content, mappings, hooks, copy/fallback/install modes, Claude settings, network rule maths, memory sizing, and the guest runner end to end in dry-run mode.
Not verified without Windows: `logon.cmd` / `bootstrap.ps1` / `netsh` on a real sandbox, real downloads, a real Claude login. The TypeScript in `src/` is generated from the same source as the tested `dist/` JavaScript, but `tsc` could not be run here, so `npm run build` may report type errors; `dist/` is what runs.
