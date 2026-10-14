# Roadmap

What is still planned. Each version is a coherent release: everything in it is built, tested in a sandbox and documented
before the version number goes up. What has shipped is in the [changelog](../CHANGELOG.md).

Status: **in progress**, **planned**, **idea** (needs a design decision or a test on a real PC first).

## 1.6 — VPN

| Item | Status |
| --- | --- |
| VPN inside the sandbox only (your PC's own connection is untouched): WireGuard and OpenVPN config files | planned |
| Providers: NordVPN (its WireGuard/OpenVPN configs), business VPNs (OpenVPN / WireGuard profiles from the company), a short list of free ones with a clear warning | planned |
| Kill switch: no traffic leaves the sandbox when the tunnel is down | planned |
| Warnings: a VPN login inside the sandbox is readable by the agent; free VPNs see all traffic; shown in the menu and at launch | planned |

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
