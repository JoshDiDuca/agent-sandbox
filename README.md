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

It checks your PC, offers to turn on Windows Sandbox, and installs everything. It uses your Node.js 20+ if you have it,
otherwise a private copy just for this tool. Nothing is installed system-wide.
Needs Windows 10/11 **Pro, Enterprise or Education**. [Other ways to install](docs/install.md)

## Use

```powershell
cd C:\code\my-app

sandbox            # menu: start an agent, a plain sandbox, diagnostics, cleanup ...
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
| **Databases** | PostgreSQL, MySQL, MongoDB, Redis and DynamoDB Local with a web UI, started only when the project uses them |
| **Agents** | Claude Code, Codex, Gemini, opencode, Qwen, Crush, Copilot, Kilo, Amp, Cline, Continue, Kimi, Aider, DeepSeek agents |
| **Smart** | Detects what the project needs from its files, respects version files, installs in parallel and reuses everything |
| **Feels like home** | Your desktop look, Claude settings, MCP servers and conversation history come along; history syncs back |

## Commands

| Command | |
|---|---|
| `sandbox` | the interactive menu: repeat your last command, start agents, every option, and all settings |
| `sandbox <agent>`, `claude-sandbox` | start an agent; `-t` for this terminal, `--headless` for no window |
| `sandbox start` | the sandbox without an agent |
| `sandbox attach` / `sessions` / `status` | work with a running sandbox |
| `sandbox exec -- <cmd>` | run a command inside |
| `sandbox stop` / `hide` / `show` | shut down, hide or show the window |
| `sandbox data` / `data clean` | what's stored and how big, and freeing space |
| `sandbox setup` / `doctor` / `repair` | check this PC, see what will be installed, fix common problems |

All commands and options: [docs/commands.md](docs/commands.md)

## Documentation

- [Install](docs/install.md): requirements, other ways to install, upgrading
- [Commands](docs/commands.md): every command and option, the menu, sessions and attaching
- [Tools and databases](docs/toolchains.md): languages, package managers, databases, agents, what is tested
- [Configuration](docs/configuration.md): settings, project files, paths, accounts, hooks
- [Security](docs/security.md): how your PC is protected, secrets, git access
- [Troubleshooting](docs/troubleshooting.md): common problems and fixes
- [Development](docs/development.md): building, testing, releasing (code layout in [CLAUDE.md](CLAUDE.md))
