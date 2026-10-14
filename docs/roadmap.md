# Roadmap

What is still planned. Each version is a coherent release: everything in it is built, tested in a sandbox and documented
before the version number goes up. What has shipped is in the [changelog](../CHANGELOG.md).

Status: **in progress**, **planned**, **idea** (needs a design decision or a test on a real PC first).

## In progress

| Item | Status |
| --- | --- |
| Menu redesign: app sections as tabs at the top, Settings keeps its categories, staged changes with Ctrl+S (unsaved count, Save / Discard / Cancel), one key bar | in progress |
| Every command that runs another command gets its own screen (accounts, sessions, projects, data, databases ...); the CLI and the menu share one implementation | in progress |
| Upgrade migrations between versions (framework and first migration done); an optional auto-updater that falls back to the current install | in progress (updater next) |
| 2.0 codebase restructure: folders by area, classes where state and behaviour belong together, no change in behaviour (the self-test is the gate); contributor docs and `CLAUDE.md` updated for the new layout | in progress on `refactor/restructure`, not merged |

## Planned

| Item | Status |
| --- | --- |
| Accounts for every agent (Claude, Codex, OpenCode, DeepSeek, Gemini ...): saved logins and configs deployed into the sandbox, menu screens for all | planned |
| Joining a running sandbox works for any agent (Codex alongside Claude ...) and any project folder. Missing mappings or settings: Restart (and resume), Continue without, or Cancel | planned |
| Resume (configurable): record what was running (agent sessions with their conversation, other terminal tabs and CLIs); after a crash or restart, start them again and continue the conversations | planned |
| Install for the current user or all users; other Windows users can see and use the running sandbox (sharing, off by default) | planned |
| "Claude on this PC is not sandboxed" only when your `claude`, `codex` ... commands are forwarded to the sandbox, per agent you have installed | planned |
| Test everything possible inside the sandbox: a second local user, an all-users install, upgrade from an old release, failed update rollback, resume after a simulated crash | planned |
| Contained storage (optional): persisted data in one VHDX disk image, mounted only while a sandbox runs (nothing it wrote is reachable on the PC at rest), with a size cap; needs one admin prompt per launch | idea: cannot be tested inside Windows Sandbox (its Virtual Disk Service does not start); needs testing on a PC before it is built |

## 1.5 — VPN

| Item | Status |
| --- | --- |
| VPN inside the sandbox only (your PC's own connection is untouched): WireGuard and OpenVPN config files | planned |
| Providers: NordVPN (its WireGuard/OpenVPN configs), business VPNs (OpenVPN / WireGuard profiles from the company), a short list of free ones with a clear warning | planned |
| Kill switch: no traffic leaves the sandbox when the tunnel is down | planned |
| Warnings: a VPN login inside the sandbox is readable by the agent; free VPNs see all traffic; shown in the menu and at launch | planned |

## Backlog (not scheduled)

- The menu remembers the last category and search per screen across runs.
- Mouse input passed on to agents beyond what 1.4.1 covers, for programs that need raw mouse input (needs Node's raw VT
  input on Windows).
- More catalogue apps on request; a "request an app" link in the Apps screen.
- Export / import of settings (a `.json` you can share with a team).
