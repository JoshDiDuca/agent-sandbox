# agent-sandbox

Runs Claude Code (or Codex / Gemini) inside Windows Sandbox, in your project folder, with tools provisioned and cached for you.
TypeScript source is in `src/`; compiled JavaScript is already in `dist/`, so there is nothing to build. You only need Node 20+ on your PC.

## Quick start (Windows 11 Pro/Enterprise/Education)

```powershell
cd C:\Scripts\agent-sandbox
node dist\index.js self-test        # offline logic tests, must say ALL TESTS PASSED
node dist\index.js doctor           # shows what will be copied / installed
node dist\index.js install-commands # adds claude-sbx, codex-sbx, gemini-sbx, claude-host to PATH (open a new terminal)

cd C:\path\to\any\project
claude-sbx                          # sandbox opens with THIS folder as C:\Workspace and Claude starts in it
```

Without installing commands: `node dist\index.js launch --here` (current folder) or `node dist\index.js launch` (project from `config.json`, default `F:\AgentProjects\mw2-agent`).
If Windows Sandbox is not enabled: elevated PowerShell, `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`, then reboot.

## What happens when it starts

1. The host writes a `.wsb` plus a launch folder and starts Windows Sandbox.
2. Windows runs the LogonCommand `sandbox\logon.cmd` (in a hidden window, which is why it only opens a visible PowerShell for the real work). It writes `C:\AgentData\logs\logon-hit.txt` as proof it ran.
3. The visible PowerShell runs `sandbox\bootstrap.ps1`: it makes sure Node exists in persistent storage (copy from your PC, or download) and runs `guest\main.js`.
4. `main.js` applies the private-network block, runs your hooks, sets up Git, gets the agent, then starts it **in `C:\Workspace`** (your folder). Every step is printed and logged.
5. First run needs a Claude login inside the sandbox (browser opens; clipboard is enabled so you can paste a code). The login is saved in persistent storage and reused.

Persistent storage is `F:\AgentSandbox\data\<project>` (mapped to `C:\AgentData`): Node, the agent, Git, logins/state, logs. First boot is slow; later boots skip whatever is cached.
Anything installed with an installer/winget inside the sandbox itself is discarded when it closes (that is how Windows Sandbox works).

## The switch: copy from your PC vs install

`config.json` -> `provisioning`:

| setting | meaning |
|---|---|
| `copyFromHost: true` | Node is copied from your PC's Node folder (nvm/MSI/zip; auto-detected from the Node running this tool, or set `node.hostDir`). Claude is copied from `claude.exe` on PATH or `~\.local\bin` (override with `harnesses.claude.hostDir`). Those folders are mapped read-only. |
| `copyFromHost: false` | Nothing is copied. Node is downloaded from nodejs.org (SHA-256 verified) and the agent is installed with npm inside the sandbox. |
| `fallbackToInstall: true` | If a host copy is missing, download/install instead of failing. `false` fails loudly. |
| `refresh: true` | Re-copy / re-install even if cached. |

Host copies never include your Claude login or settings; the sandbox uses its own profile (`CLAUDE_CONFIG_DIR` under `C:\AgentData\state`).

## Run your own script in the sandbox (the hook)

Put files in `hooks\pre-provision`, `hooks\pre-agent` or `hooks\post-agent` (`.ps1`, `.mjs`, `.cmd`; run in name order), or pass one-offs:

```powershell
node dist\index.js launch --here --script C:\code\my-setup.ps1 --script C:\code\other.mjs
```

Hooks run inside the sandbox in your workspace with `AGENT_WORKSPACE`, `AGENT_DATA`, `AGENT_TOOLS`, `AGENT_PROJECT` set. A failing hook warns and continues unless `hooks.failFast` is true. `hooks\pre-agent\00-hello.ps1` is a harmless example.

## Commands

`launch`, `generate` (no start), `doctor`, `host-claude` (Claude on your PC, **not sandboxed**, separate profile unless `--personal`), `install-commands [--shadow]` (`--shadow` also creates `claude` that launches the sandbox), `self-test`.
Options: `--here`, `--workspace <dir>`, `--project`, `--harness claude|codex|gemini`, `--script <file>`, `--no-agent`, `--config`, and `-- <args>` passed to the agent (e.g. `claude-sbx -- --continue`).

## Network

`network.blockPrivateRanges` switches the guest to public DNS and adds guest firewall rules blocking 10/8, 172.16/12, 192.168/16, 169.254/16, multicast, IPv6 local and SMB. If DNS stops working after the rules, they are removed and a warning is printed. This is enforced **inside** the guest, so an agent with admin rights could undo it, and the guest can still see its own subnet. The only hard guarantee Windows Sandbox offers is `sandbox.networking: false` (no internet at all).

## Safety defaults

Workspace is read/write; game folders are read-only and optional (skipped if missing). Drive roots and your whole user profile are refused as mappings. Clipboard is on (needed for login); audio/video/printers off. vGPU on (no CUDA guarantee). One sandbox can run at a time.

## Troubleshooting

After a launch, look at `F:\AgentSandbox\data\<project>\logs\`:

- `logon-hit.txt` missing: Windows never ran the logon command. Look for a Windows Sandbox error dialog, and make sure no other sandbox was already running.
- `logon-hit.txt` present but no PowerShell window: tell me what the sandbox desktop shows.
- `bootstrap-*.log`, `bootstrap-error.txt`: the PowerShell stage (Node).
- `guest-*.log`, `guest-error.txt`: the main runner (hooks, Git, agent). Failures print in red in the sandbox window, which stays open.

If a copied `claude.exe` will not start in the sandbox, set `copyFromHost` to `false`.

## What was and was not verified

Verified offline (`self-test`): config validation, `.wsb` content, mappings, workspace/session files, logon.cmd contents, hook execution, copy mode, fallback, install mode, no-fallback failure, memory sizing, root-folder refusal, and the guest runner end to end in dry-run mode.
Not verified (no Windows available when this was built): `logon.cmd` / `bootstrap.ps1` on a real sandbox, real downloads, a real Claude login. The TypeScript in `src/` is generated from the same source as the tested `dist/` JavaScript, but `tsc` could not be run, so `npm run build` may report type errors; `dist/` is what runs.
