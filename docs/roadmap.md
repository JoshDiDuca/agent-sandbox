# Roadmap

What is still planned. Each version is a coherent release: everything in it is built, tested in a sandbox and documented
before the version number goes up. What has shipped is in the [changelog](../CHANGELOG.md).

Status: **in progress**, **planned**, **idea** (needs a design decision or a test on a real PC first).

## 1.7 — VPN (NordVPN first)

| Item | Status |
| --- | --- |
| NordVPN inside the sandbox only (your PC's own connection is untouched): sign in to your Nord account on the website with your normal login once, copy its service credentials, and `sandbox vpn login` keeps them encrypted on this PC (never your account password) | in progress |
| Credentials stored safely: encrypted at rest (Windows DPAPI, your user only), never in launch folders, `--json` or logs | in progress |
| Later: your own OpenVPN / WireGuard file (business VPNs), NordLynx (WireGuard) | planned |
| Kill switch: no traffic leaves the sandbox when the tunnel is down | planned |
| Warnings: a VPN login inside the sandbox is readable by the agent; free VPNs see all traffic; shown in the menu and at launch | planned |

## 1.9 — Web UI (the release before 2.0)

Design and security model: [web-ui.md](web-ui.md).

| Item | Status |
| --- | --- |
| Foundation: `sandbox web` (loopback only, token + cookie login), the terminal bridge, a React app with sessions, a live terminal and new sessions; off by default | in progress |
| Plain shell sessions through ptyhost, so terminals you open show up in the web UI too; closing a session | planned |
| Settings rows and a menu entry; a phone-sized layout with an on-screen key row (Esc, Tab, Ctrl, arrows) | planned |
| Other Windows users of the PC: their own `sandbox web` shows your sandbox when you share it, under the same rules as the CLI | planned |
| From a phone on your network: opt-in HTTPS, pairing per device (QR code), revocable devices, a private-network firewall rule | planned |

## Ideas

| Item | Status |
| --- | --- |
| Contained storage (optional): persisted data in one VHDX disk image, mounted only while a sandbox runs (nothing it wrote is reachable on the PC at rest), with a size cap; needs one admin prompt per launch | idea: cannot be tested inside Windows Sandbox (its Virtual Disk Service does not start); needs testing on a PC before it is built |

## Backlog (not scheduled)

- The menu remembers the last category and search per screen across runs.
- Mouse input passed on to agents beyond what 1.4.1 covers, for programs that need raw mouse input (needs Node's raw VT
  input on Windows).
- More catalogue apps on request; a "request an app" link in the Apps screen.
- Export / import of settings (a `.json` you can share with a team).
