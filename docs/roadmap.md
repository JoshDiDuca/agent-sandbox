# Roadmap and backlog

What is planned, by version. Each version is a coherent release: everything in it is built, tested in a sandbox and
documented before the version number goes up. Status: **done**, **in progress**, **planned**, **idea** (needs a
design decision first).

## 1.2 — The app (released)

| Item | Status |
| --- | --- |
| Full-screen menu: categories, search, command forms with the live command line, running sessions to attach to | done |
| Settings editor: categories, search, value / default / source per setting, structured editors for lists, maps, folders and agents (no JSON typing) | done |
| Apps catalogue: 60 apps and CLI tools by category (editors, database clients, API clients, Git, utilities, browsers, game dev, cloud, network, CLI tools), searchable, installed portably | done |
| Your own programs (`apps.custom`): a GitHub release or an https link, edited as a form | done |
| VS Code set up for the sandbox's tools (JDK, Python, Go, compilers, .NET, Git, terminals) with the extensions for the languages in use | done |
| Windows Terminal: new tabs no longer fail (`AGENT_WORKSPACE` set before Terminal starts) | done |
| Agent sessions on Microsoft's newer ConPTY: no garbled screen after resizing, real scrollback for the mouse wheel; late viewers get a replay | done |
| Security: attach output filter rewritten (OSC 52 bypasses), project files cannot map folders outside the project, repo guard covers Claude/VS Code/MCP files, submodules and more git keys | done |

## 1.3 — Settings and network

| Item | Status |
| --- | --- |
| Git-ignored files and folders (node_modules, .env, build output ...) kept out of the sandbox, seamlessly (`workspaceFilter`: a filtered copy synced both ways, the real .git mapped beside it) | done |
| Settings scope tabs: "All projects" and "This project" side by side, Tab switches, each with its own colour and badge | done (in 1.2) |
| A project asking for something only you can allow (vGPU, ...) is said at launch, with how to allow it, instead of being dropped silently | done |
| Rust: `CARGO_TARGET_DIR` per checkout (git worktrees of several agents no longer share one target folder); gnu defaults that fit Windows (fewer jobs, `debug = "line-tables-only"` under the 2 GB executable limit) | done |
| Git in the sandbox: `core.autocrlf` no longer `true` (worktrees made inside checked out CRLF) | done |
| claude-mem: keep a few dated backups instead of replacing the only copy | done |
| `py` launcher next to `python` | done |
| Network category: allow only these hosts (proxy + firewall), blocked hosts, LAN block, DNS, an upstream proxy, port forwarding from the PC into the sandbox | done |
| Security sweep, rest of the audit: history and claude-mem sync back (only this project's, no foreign transcripts), what is copied in (other projects' history, `file-history`), sandbox text shown without escape codes everywhere, attach only to the sandbox's own address, logs folder link checks | done |

## 1.4 — Accountability and containment

| Item | Status |
| --- | --- |
| Audit log (optional): commands agents run, files changed in the workspace, sessions, repo-guard findings; kept *n* days, size-capped, compressed daily | planned |
| Contained storage (optional): persisted data in one VHDX disk image, mounted only while a sandbox runs (nothing it wrote is reachable on the PC at rest), with a size cap; needs one admin prompt per launch | idea: test mounting in a sandbox first |
| Smaller containment options without admin: "downloaded from the internet" mark on everything the sandbox wrote, a size cap on persisted data, read-only mappings by default | planned |

## 1.5 — VPN

| Item | Status |
| --- | --- |
| VPN inside the sandbox only (your PC's own connection is untouched): WireGuard and OpenVPN config files | planned |
| Providers: NordVPN (its WireGuard/OpenVPN configs), business VPNs (OpenVPN / WireGuard profiles from the company), a short list of free ones with a clear warning | planned |
| Kill switch: no traffic leaves the sandbox when the tunnel is down | planned |
| Warnings: a VPN login inside the sandbox is readable by the agent; free VPNs see all traffic; shown in the menu and at launch | planned |

## 2.0 — Codebase

| Item | Status |
| --- | --- |
| Restructure into folders by area with fewer files per folder; classes where state and behaviour belong together; no change in behaviour (the self-test is the gate) | planned |
| Contributor docs and `CLAUDE.md` updated for the new layout and style | planned |

## Backlog (not scheduled)

- The menu remembers the last category and search per screen across runs.
- Mouse input passed through to agents that ask for it (needs Node's raw VT input on Windows).
- More catalogue apps on request; a "request an app" link in the Apps screen.
- Export / import of settings (a `.json` you can share with a team).
