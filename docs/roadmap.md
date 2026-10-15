# Roadmap

What is still planned. Each version is a coherent release: everything in it is built, tested in a sandbox and documented
before the version number goes up. What has shipped is in the [changelog](../CHANGELOG.md).

Status: **in progress**, **planned**, **idea** (needs a design decision or a test on a real PC first).

## To verify on a real PC (shipped, but only tested inside a sandbox)

| Item | What to check |
| --- | --- |
| NordVPN, your own OpenVPN or WireGuard file, the kill switch (1.7.0, 1.8.0) | [vpn.md](vpn.md#what-is-not-tested-yet): the driver in Windows Sandbox, traffic through the tunnel, nothing leaks with it down, attach still works |
| Later: NordLynx (NordVPN over WireGuard) | planned once the above works |

## 1.9 — Sandbox engines and contained storage (opt-in: contained storage beta, HCS engine alpha)

Windows Sandbox stays the default and keeps every feature it has; these are extras you switch on, and one setting
switches them off again. Design: [design/hcs-backend.md](design/hcs-backend.md).

| Item | Status |
| --- | --- |
| An engine layer: today's Windows Sandbox launch behind one interface (unchanged behaviour on every Windows Sandbox version), so other engines can plug in | done (`sandbox engine`) |
| Contained storage for Windows Sandbox (`storage.contained`): tools, logins and logs in one VHDX per data set, mounted on a private folder only while a sandbox runs and mapped in as folders today are; one admin prompt per launch; stale-mount repair in doctor | built (beta, `sandbox storage contained on`), tested only with a fake disk and the scripts' dry-run: first run `scripts/experiments/Test-ContainedStorage.ps1` and then the checklist in [design/engines.md](design/engines.md) on a PC |
| An HCS engine (`sandbox.engine: hcs`, alpha): headless agents in a Hyper-V isolated Server Core container with the storage VHDX attached to the VM (never mounted on the PC) | built as an alpha (documents checked against Microsoft's schema, the check, HcsHost.exe with its safety guards); starting it stays disabled until the go/no-go test (Docker Desktop, Windows containers, Hyper-V isolation: the terminal bridge, Node and csc inside Server Core); `scripts/experiments/hcs/Test-Hcs.ps1` shows what this PC allows |
| A small helper installed by the all-users installer, so contained storage needs no admin prompt per launch | idea (after the above) |

## 2.0 — Web UI

Being built separately; reviewed and merged here. Design and security model: [web-ui.md](web-ui.md).

| Item | Status |
| --- | --- |
| Foundation: `sandbox web` (loopback only, token + cookie login), the terminal bridge, a React app with sessions, a live terminal and new sessions; off by default | built (1.6.0), being extended |
| Plain shell sessions through ptyhost, so terminals you open show up in the web UI too; closing a session | planned |
| Settings rows and a menu entry; a phone-sized layout with an on-screen key row (Esc, Tab, Ctrl, arrows) | planned |
| Other Windows users of the PC: their own `sandbox web` shows your sandbox when you share it, under the same rules as the CLI | planned |
| From a phone on your network: opt-in HTTPS, pairing per device (QR code), revocable devices, a private-network firewall rule | planned |

## Backlog (not scheduled)

- Code signing for releases and HostTools.exe (Azure Trusted Signing), so antivirus heuristics stop flagging them.
- Mouse input passed on to agents beyond what 1.4.1 covers, for programs that need raw mouse input (needs Node's raw VT
  input on Windows).
- More catalogue apps, as people ask for them (Apps > Request an app… opens the request form).
