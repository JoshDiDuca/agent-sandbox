# Tools and databases

Everything installs once into persistent storage (`C:\AgentData` inside) and is reused by every later sandbox.

Only what the project needs gets installed. Every language defaults to **auto**, which your PC decides at launch from
the project's files in the workspace and one folder down (`go.mod`, `*.csproj`, `*.py` ...). A folder that isn't a
project yet gets the languages your PC has. The launch output lists each toolchain and why. `true` / `false` in the
config always win.

## Languages

✅ means tested on real projects. Everything else is installed for real in a sandbox and checked with a small project.

| | | Version from |
|---|---|---|
| **Node** ✅ | nvm, npm, pnpm and yarn via corepack, **Volta** when the project pins it | `.nvmrc`, `.node-version`, `package.json` volta, your PC |
| **Python** ✅ | CPython 3 + pip, Python 2.7 (`python2`), uv, pyenv-win when your PC uses pyenv | `.python-version` |
| **Rust** ✅ | rustup, cargo (GNU host) | `rust-toolchain.toml` |
| **C / C++** ✅ | MinGW-w64 GCC, CMake, Ninja, premake5, win_flex/bison | |
| **C# / .NET** ✅ | .NET SDK, workloads, global tools, .NET Framework reference assemblies (net48, net472 ...) | `global.json` |
| Go | go.dev, `GOTOOLCHAIN=auto` | `go.mod` |
| Java | Temurin JDK, Maven, Gradle | `.java-version`, `.sdkmanrc` |
| Ruby | RubyInstaller, gems | `.ruby-version` |
| PHP | PHP with common extensions, Composer | `.php-version` |
| Deno, Bun | single binaries | |
| VS Code | portable, `code .`; settings and extensions are kept | |
| Mesa 3D (opt-in) | software OpenGL 4.5 for games and apps without a GPU | |

Global packages per ecosystem can be listed in the config (`npm`, `uv tool`, `go install`, `gem`, `cargo install`,
`dotnet tool`, rustup components). Installs that persist on their own: `npm i -g`, `pip`, `cargo install`,
`dotnet tool -g`, `uv tool`, `go install`, `gem install`. Real installers (MSI, winget) need a hook script.

### Mapped folders

The workspace and `C:\AgentData` are folders shared from your PC, and Windows Sandbox allows no symlinks or junctions
in them. The sandbox sets pnpm to a flat `node_modules`, keeps Bun's cache on its own disk and turns off Gradle's
file watching. npm workspaces with `file:` links, Deno's `node_modules` mode and Bun lockfile saves still cannot work
there; use a folder on `C:\` outside them.

## Databases

Each database starts only when the project needs it. That's found from compose images, dependencies in every
ecosystem (pg, psycopg, Npgsql, mongoose, ioredis, AWS DynamoDB SDKs ...), Prisma and ORM config, CloudFormation /
SAM / Terraform tables, connection strings and `.env` templates. A project with only an ORM gets the database your PC
has installed. The launch output says what was found and why. Data is kept; servers listen on localhost only.

| | Connect with |
|---|---|
| **PostgreSQL** | `postgres://postgres@localhost:5432/postgres`, no password; psql and pg_dump on PATH |
| **MySQL** (MariaDB) | `mysql://root@127.0.0.1:3306`, no password |
| **MongoDB** | `mongodb://127.0.0.1:27017`, mongosh on PATH |
| **Redis** | `redis://127.0.0.1:6379` |
| **DynamoDB Local** | `http://localhost:8000`; web UI (dynamodb-admin) at <http://localhost:8001>; AWS SDKs connect automatically |

Not possible inside Windows Sandbox: **SQL Server** (LocalDB cannot start there) and **Docker** (no nested
virtualization). Compose projects use the databases above.

## Agents

| | |
|---|---|
| **Claude Code** ✅ | copied from your PC, or installed |
| Codex, Gemini | supported |
| opencode, Qwen Code, Crush, GitHub Copilot CLI, Kilo Code, Amp, Cline, Continue, Kimi, Aider | untested, each from its official package |
| Reasonix, CodeWhale (`deepseek`) | untested; community agents for DeepSeek, which has no official CLI |

Add your own under `harnesses` in the config, with `npmPackage` / `npmBin`, `uvPackage` / `uvBin` or `hostExecutable`.

## Also in the sandbox

- Windows Terminal, your desktop look (theme, accent, taskbar, wallpaper, regional settings)
- Git for Windows with Git Bash, your name and email only
- Your Claude settings, CLAUDE.md, commands, agents, skills, plugins and MCP servers, with credentials stripped
- Conversation history and claude-mem, synced both ways
- For games: Mesa, or `sandbox.vGpu: true` for the GPU; audio; game data from a mapped folder
