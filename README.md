<div align="center">

# Windows Development Sandbox

**A throwaway Windows machine for every project, with or without an AI agent.**

[![Release](https://img.shields.io/github/v/release/JoshDiDuca/windows-development-sandbox?label=release)](https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest)
[![CI](https://github.com/JoshDiDuca/windows-development-sandbox/actions/workflows/ci.yml/badge.svg)](https://github.com/JoshDiDuca/windows-development-sandbox/actions/workflows/ci.yml)
![Windows 10/11 Pro, Enterprise, Education](https://img.shields.io/badge/Windows-10%20%7C%2011%20Pro-0078D4)
![MIT](https://img.shields.io/badge/license-MIT-green)

</div>

Run it in a project folder and you get a clean [Windows Sandbox](https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-overview)
where that folder is the workspace, the tools and databases the project needs install themselves, and nothing else
on your PC is reachable. Close it and it's gone. Your project, tools, databases and logins are kept for next time.

## Install

```powershell
irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1 | iex
```

It checks your PC, offers to turn on Windows Sandbox, and asks **1) Just me** or **2) Everyone on this PC** (needs
admin). It uses a private copy of Node.js just for this tool; nothing else is installed system-wide. `sandbox update`
installs newer versions, and can do it by itself.
Needs Windows 10/11 **Pro, Enterprise or Education**. Have Node.js 20+? `npm install -g windows-development-sandbox`
works too. [Scopes, options, upgrading, uninstall](docs/install.md)

## Use

```powershell
cd C:\code\my-app

sandbox            # the menu: start agents, sessions, apps, every setting, diagnostics ...
sandbox claude     # Claude Code in a sandbox for this folder (or: claude-sandbox)
sandbox claude -t  # ... in this terminal (Ctrl+] detaches, the session keeps running)
sandbox start      # just the sandbox, no agent
sandbox opencode   # any supported agent by name
```

The first start downloads what the project needs (a few minutes, once). After that, starts take seconds.

> `claude-sbx`, `codex-sbx`, `gemini-sbx` and `agent-sandbox` are the old command names. They still work for now; use
> `sandbox <agent>` / `claude-sandbox` and `sandbox` instead.

## What you get

|  |  |
|---|---|
| **Safe by default** | The agent sees only your project folder. Credentials are stripped before anything is copied in, your LAN is blocked, and nothing the sandbox writes can run on your PC. |
| **Languages** | Node, Python, Rust, C/C++ (GCC or MSVC), .NET (incl. .NET Framework targeting), Go, Java, Ruby, PHP, Deno, Bun, PowerShell 7, with pnpm, yarn, Volta, uv, pyenv, Maven, Gradle, Composer, gh ... |
| **Apps and tools** | VS Code (set up for your languages, with their extensions) and Windows Terminal, plus 60 optional apps and tools by category: DBeaver, pgAdmin, Bruno, Godot, Blender, kubectl, jq, ripgrep ... and programs of your own |
| **Databases** | PostgreSQL, MySQL, MongoDB, Redis and DynamoDB Local with a web UI, started when the project uses them, or any time with `--database` / `sandbox db` |
| **Agents** | Claude Code, Codex, Gemini, opencode, Qwen, Crush, Copilot, Kilo, Amp, Cline, Continue, Kimi, Aider, DeepSeek agents |
| **Smart** | Detects what the project needs from its files, respects version files, installs in parallel and reuses everything |
| **Several projects** | `sandbox claude` from another project joins the running sandbox: its own folder, tools, versions, databases and environment, set up on demand. Start several agents at once (`--session claude@A --session codex@B`, or the menu) and attach to any of them from any terminal |
| **Agent commands** (Beta) | `sandbox agent-commands on`: typing `claude`, `codex` ... in any folder starts it in a hidden sandbox and attaches your terminal |
| **Feels like home** | Your desktop look, Claude settings, MCP servers and conversation history come along; history syncs back |

## Commands

| Command | |
|---|---|
| `sandbox` | the menu, a full-screen app: start agents, attach to sessions, pick apps, edit every setting (yours and the project's), all commands, with search |
| `sandbox <agent>`, `claude-sandbox` | start an agent; `-t` for this terminal, `--headless` for no window |
| `sandbox start` | the sandbox without an agent |
| `sandbox attach` / `sessions` / `status` | work with a running sandbox (this folder's project first) |
| `sandbox projects` | the projects a sandbox can open without a restart: roots, `all`, exclude |
| `sandbox db [start\|stop <name>]` | list, start or stop databases (`sbx-db` inside) |
| `sandbox exec -- <cmd>` | run a command inside |
| `sandbox agent-commands on\|off` | (Beta) make the agents installed on this PC start in a sandbox |
| `sandbox --version` | the installed version |
| `sandbox stop` / `hide` / `show` | shut down, hide or show the window |
| `sandbox data` / `data clean` | what's stored and how big, and freeing space |
| `sandbox setup` / `doctor` / `repair` | check this PC, see what will be installed, fix common problems |

All commands and options: [docs/commands.md](docs/commands.md)

## Known gaps

Adding a folder to a RUNNING sandbox needs Windows 11 24H2+ with the updated Windows Sandbox (`wsb share`, untested).
On older Windows, folders inside a project root open at once and anything else offers a restart. Details, and how to
get `wsb`: [several projects](docs/projects.md#adding-folders-to-a-running-sandbox-wsb-share).

## Documentation

- [Install](docs/install.md): requirements, other ways to install, upgrading
- [Commands](docs/commands.md): every command and option, the menu, sessions and attaching
- [Tools and databases](docs/toolchains.md): languages, package managers, databases, agents, what is tested
- [Configuration](docs/configuration.md): settings, project files, paths, accounts, hooks
- [Several projects](docs/projects.md): project roots, adding a project to a running sandbox, what each agent can see
- [Changelog](CHANGELOG.md): what shipped in each version
- [Security](docs/security.md): how your PC is protected, secrets, git access
- [VPN](docs/vpn.md): send the sandbox through NordVPN (or your own OpenVPN profile), with a kill switch
- [Troubleshooting](docs/troubleshooting.md): common problems and fixes
- [Development](docs/development.md): building, testing, releasing (code layout in [CLAUDE.md](CLAUDE.md))
