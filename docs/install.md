# Install

## Requirements

- Windows 10 or 11 **Pro, Enterprise or Education** (Home has no Windows Sandbox)
- Virtualization turned on in the BIOS/UEFI
- 8 GB RAM or more is comfortable; the sandbox takes what is free, minus a reserve for your PC
- Node.js 20+, or none: the installer then uses a private Node.js just for this tool

## One line

```powershell
irm https://github.com/JoshDiDuca/agent-sandbox/releases/latest/download/install.ps1 | iex
```

It checks the edition, virtualization, RAM and disk, and offers to turn on Windows Sandbox (that step asks for admin
and needs a reboot). It then installs the package and runs `sandbox doctor`.

It uses your Node.js 20+ if you have one. Otherwise it downloads the official Node.js LTS zip, checks its SHA-256 and
unpacks it into `%LOCALAPPDATA%\WindowsDevelopmentSandbox\node`, used only to run this tool. Your PATH only gets a small
folder with this tool's commands, not `node` itself, so nothing is installed system-wide.

## By hand

```powershell
# 1. Windows Sandbox, in an admin PowerShell, then reboot
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All

# 2. The package: from npm, the latest release, a specific one, or from the repository
npm install -g windows-development-sandbox
npm install -g https://github.com/JoshDiDuca/agent-sandbox/releases/latest/download/windows-development-sandbox.tgz
npm install -g https://github.com/JoshDiDuca/agent-sandbox/releases/download/v1.0.0/windows-development-sandbox-1.0.0.tgz
npm install -g github:JoshDiDuca/agent-sandbox

# 3. Check
sandbox setup     # edition, virtualization, Windows Sandbox, RAM, disk, Node
sandbox doctor    # what will be copied from this PC or downloaded
```

## Upgrading

Run the one-liner again, or `npm install -g` the latest release. Coming from the old `agent-sandbox` package, the
installer removes it first (both ship the same commands); your storage, logins and config carry over.

## First start

The first start downloads what the project needs and cannot copy from your PC: a few minutes, once, with installers
running in parallel. The sandbox window and `sandbox status` show what is being installed. Everything is kept in
persistent storage, so later starts take seconds.
