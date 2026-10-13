# Troubleshooting

Start with `sandbox repair`, then `sandbox doctor` and `sandbox logs -f`.

| Problem | Try |
|---|---|
| Windows Sandbox missing | `sandbox setup` checks the edition and virtualization, and offers to turn it on |
| "A Windows Sandbox is already running" | Only one runs at a time: `sandbox status`, then `sbx-show` or `sandbox stop` |
| A toolchain failed on first start | The rest still works. `sandbox repair` removes the half-install, so the next start retries |
| Install commands fail | `npm install -g` needs Node.js 20+; the one-liner installs it. Check your internet and try again |
| The first start is slow | Expected once: it downloads what the project needs. Later starts reuse it |
| Disk filling up | `sandbox data` shows what is big; `sandbox data clean <part>` frees it |
| Config errors | The message names the key and the problem; `sandbox config show` prints the effective config |
| pnpm, Bun or npm workspaces fail with EPERM | Mapped folders allow no symlinks; see [mapped folders](toolchains.md#mapped-folders) |
| A database didn't start | Check `sandbox logs`. Turn it on explicitly with `databases.<name>.enabled: true` |
| Can't delete `toolsmsvc` | MSVC's telemetry helper (`vctip.exe`) is removed on each start so nothing keeps it locked; if a delete still fails, close the sandbox first |
| MSVC is not installed | Set `toolchains.msvc.acceptLicense: true`; the launch output says when a project would use it |
| The sandbox was gone in the morning | The next launch says why, from Windows' own logs. Windows inside the sandbox can crash under very heavy memory use (many parallel builds): `C:\AgentData\logs\memory-*.log` shows what used memory just before; `sandbox.pageFileMb` gives it a fixed paging file at start, and fewer builds at once (cargo `build.jobs`) helps. Switching user does not close it; signing out, restarting or sleep does. The launch and `sandbox doctor` warn when Windows Update is waiting to restart: restart first, or pause updates. `sandbox.keepAwake` (on by default) stops the PC from sleeping while a sandbox runs. Conversations are kept: `/resume` in Claude |
| A project's `vGpu: true` (or another looser setting) is not used | A project file may only tighten your settings. Start it once from an interactive terminal and answer yes to "Allow these for this project?", or set it in your own settings. `sandbox config check` in the project shows what is allowed |
| "maps N folders outside the project" | The project's `.sandbox-config.json` maps folders from elsewhere on your PC (a repo ships that file). Start it from an interactive terminal and answer yes, or set `projects.allowOutsideMappings` to `true` in your settings. `sandbox config check` previews every folder: where it appears and whether it is allowed |
| A mapped folder is at `C:\Mapped\...` | The path it asked for is one the sandbox keeps for itself (`C:\Windows`, `C:\Users`, `C:\AgentData`, ...) or is already used; the launch says which. Leave `guest` out to use the PC path, or pick another folder |
| The sandbox slows my PC down | Lower `sandbox.cpuLimit` (e.g. `50`) and `sandbox.maxMemoryPercent`; they apply from the next start |
| No Vulkan | Windows Sandbox has none: `toolchains.mesa.vulkan: true` gives software Vulkan, `sandbox.vGpu: true` Direct3D 12 |
| winget is missing | Windows Sandbox has no winget; everything here installs portably, and real installers go in a hook |
| `self-test` or `npm test` refuses to run | By design: it starts real processes and creates files and links, so it only runs inside a Windows Sandbox (`sandbox start`) or on GitHub Actions |
| `sandbox launch` says you are inside the sandbox | Commands that control the sandbox run from your PC, not from inside it |
| Check a project file | `sandbox config check` validates `.sandbox-config.json` and lists what it changes |
| Another project "needs a restart" | Windows Sandbox cannot add folders while it runs. Folders inside a project root open at once: `sandbox projects roots add <parent folder>` (from the next start). On Windows 11 24H2+ with the updated Windows Sandbox, `wsb share` adds them live (untested) |
| Getting `wsb` | Settings > Windows Update: "Get the latest updates as soon as they're available" (or the Windows 11 Installation Assistant), then update Windows Sandbox in the Microsoft Store. `wsb --version` shows it; `sandbox doctor` says whether it is found |
| "needs stricter protection than the running sandbox has" | A project asking for stricter git access, no network, the LAN block or read-only cannot join a sandbox started with looser settings (they are machine-wide). Stop it and start from that project |
| Hooks quarantined in a project root | A project that appeared in a root after the start has no baseline, so its git hooks and `core.hooksPath` count as added inside the sandbox. `sandbox status` lists them; move them back if they are yours |
