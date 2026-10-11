# Commands

`sandbox` (also `windows-development-sandbox`) is the command. `sandbox <agent>` starts any configured agent;
`claude-sandbox`, `codex-sandbox` and `gemini-sandbox` are shortcuts. The old names `agent-sandbox`, `claude-sbx`,
`codex-sbx` and `gemini-sbx` still work for now.

## The menu

`sandbox` with no arguments opens a menu:

1. **Repeat last**: the last command you ran, typed or from the menu
2. Start the default agent, **several agents at once** (pick projects, then agents for each, then which one this
   terminal attaches to; it builds a `--session` command line), or pick another agent (shows which are installed)
3. Start a sandbox without an agent
4. Sandbox, sessions, accounts, data, diagnostics, configuration
5. **Settings**: every setting with its value and description, changed and saved from the menu. It first asks which
   file: your own (all projects), or this folder's `.sandbox-config.json` (only what a project may set). Saving a
   project file does not approve it: the next launch shows what it applies and asks you to approve the changed file.
   Lists of objects and maps (`harnesses`, `mappings`, environment variables) are edited as JSON, with an example shown.

Each command asks for its arguments and options, with on/off options as checkboxes and agents, accounts and sessions
as lists. It then shows the exact command line and runs it.

## Starting

| | |
|---|---|
| `sandbox claude` | start Claude in a sandbox for this folder, in Windows Terminal inside it (also `claude-sandbox`) |
| `sandbox start` | the sandbox without an agent |
| `sandbox launch` | the same, with any `--harness` |

Options:

| Option | |
|---|---|
| `-t, --terminal` | run in this terminal. In a running sandbox it reattaches to this folder's session if no terminal is attached to it |
| `--new` | always start a new session |
| `--headless` / `--window` | hide the sandbox window / show it even if config says headless |
| `--harness <agent>`, `--account <name>` | which agent, which Claude account |
| `--node <v>`, `--python <v>` | override the versions |
| `--workspace <dir>` | another folder instead of the current one |
| `--database <name>` | also start this database, e.g. `--database postgres,redis` (repeatable) |
| `--script <file>` | run a `.ps1`/`.mjs`/`.cmd` inside before the agent (repeatable) |
| `--no-agent`, `--trust-config`, `--no-local-config` | no agent, approve the project file, ignore the project file |
| `--session <agent>@<folder>` | several sessions at once (repeatable), e.g. `--session claude@C:\code\api --session codex@C:\code\api --session claude@C:\code\web`; one sandbox maps every folder, each session gets its own tab inside, `-t` attaches the first. Arguments after `--` go to every session; `"codex@C:codeweb|--model o3"` gives one session its own (`|` can't be in a Windows path) |
| `--yes` | when this folder is not in the running sandbox and adding it needs a restart, restart without asking |

Anything else goes to the agent: `sandbox claude --continue`. If an agent has a flag with the same name as ours, use
`--sbx-<flag>` for ours or put the agent's flags after `--`.

## A running sandbox

| | |
|---|---|
| `sandbox attach [id]` | show a session in this terminal (`Ctrl+]` detaches); without an id it offers the sessions, this folder's project first |
| `sandbox sessions` | sessions, their project and who is attached (`*` = this folder's project) |
| `sandbox status` | the whole sandbox: the machine, then every project (its folders, setup, databases, sessions, repo-guard findings), this folder's marked |
| `sandbox db [start\|stop <name>]` | list, start or stop this folder's project's databases (`sbx-db` inside) |
| `sandbox exec -- <cmd>` | run a command in this folder inside the sandbox, with its project's tools (`--timeout`, `--workspace`) |
| `sandbox restart` | restart this folder's project's agents in place; they resume their conversation (`--all`: every project's) |
| `sandbox stop` | shut down (history syncs back); asks first when other projects' sessions would end (`--yes` skips) |
| `sandbox show` / `hide` | show or hide the window (`sbx-show`, `sbx-hide`); hidden, it keeps running |

Sessions can be shown in the sandbox and in your terminal at the same time, by any number of terminals. Closing a tab
or a terminal never stops a session; only the agent exiting does.

## Several projects

Every command above works from any project's folder and acts on that project. From a folder the running sandbox does
not have yet, `sandbox claude` (any agent, `start`, `exec`, `db`) adds it without a restart when it can:

1. inside a **project root** (`projects.roots`, mapped at every start): at once, also for folders created after the
   start;
2. on Windows 11 24H2+ with the updated Windows Sandbox: `wsb share` (untested; any error falls back to 3);
3. otherwise you are offered a **restart** that maps it too. It lists the sessions that will end, keeps your files,
   tools, databases and logins, and can reopen those sessions (continuing their conversations). `--yes` skips the
   question; without a terminal it is never done without `--yes`.

The project is then set up on demand (its toolchains, versions, databases and its `.sandbox-config.json`, approved as
at a launch) and its sessions run with its own folder and environment. Inside the sandbox, `sbx-shell <project>` opens
a terminal in a project with its tools.

| `sandbox projects ...` | |
|---|---|
| (nothing) / `list` | the projects you have started, whether they are mapped at the start, and which are in the running sandbox |
| `choose` | tick the projects mapped at every start (turns `projects.all` on; the rest are excluded) |
| `all on\|off` | map every known project at every start (`projects.all`) |
| `exclude <folder>` / `include <folder>` | leave one out of `all` / take it back |
| `add <folder>` / `remove <folder>` | add a folder to your projects / forget it (its files are never touched) |
| `roots [list\|add\|remove <folder>]` | folders whose subfolders are projects, mapped at every start |

Changes to what is mapped apply from the next start.

## Data and maintenance

| | |
|---|---|
| `sandbox data` | what is kept between sandboxes and how big it is, and disk usage per drive |
| `sandbox data clean <targets>` | delete parts: `tools/go`, `tools`, `databases/postgres-18`, `databases`, `logs`, `launches`, `state/claude`, `all` |
| `sandbox clean [--days n]` | delete old launch folders, logs and leftovers |
| `sandbox sync` | copy history back to this PC now |
| `sandbox logs [-f]` | the sandbox log |

## Diagnostics

| | |
|---|---|
| `sandbox setup` | check this PC (edition, virtualization, Windows Sandbox, RAM, disk, Node) and offer fixes |
| `sandbox doctor` | what will be copied from this PC or downloaded |
| `sandbox repair` | find and fix stale state, interrupted downloads, half-installed tools, broken caches |
| `sandbox generate` | dry run: what a launch would do, without starting anything |
| `sandbox self-test [suite...]` | the built-in tests (only inside a Windows Sandbox); name suites to run just those |

## Accounts and config

| | |
|---|---|
| `sandbox account list` | Claude accounts |
| `sandbox account save <name> [--from-host]` | save the sandbox's (or this PC's) login |
| `sandbox account use <name>` / `default <name>` / `remove <name>` | switch now (Claude restarts and continues) / for new sandboxes / delete |
| `sandbox config` | short summary: settings file, default agent, storage |
| `sandbox config show` / `path` / `init` / `schema` | all settings with defaults filled in as JSON / the file / create it / editor schemas |
| `sandbox config check [--workspace <dir>]` | check a project's `.sandbox-config.json` and list what it changes, without starting anything |
| `sandbox agent-commands [status\|on\|off]` | **(Beta)** typing an agent's own command on this PC (`claude`, `codex` ...) starts it in a hidden sandbox for the folder you are in and attaches that terminal. See [agent commands](configuration.md#agent-commands-beta) |
| `sandbox host-claude` (or `claude-host`) | Claude on this PC, **not** sandboxed, with its own profile (`--personal` uses your normal one) |

`sandbox --version` (or `-v`) prints the version. Inside a sandbox, commands that control it from outside (`launch`,
`attach`, `exec`, `stop`, `show`, `hide`, `restart`) say so and do nothing; `sandbox db` runs `sbx-db` right there.

Every command also takes `--config <file>` (before or after the command) to use another settings file. Colours are off
with `NO_COLOR`, `TERM=dumb` or piped output (`FORCE_COLOR=1` forces them). Unknown agents, accounts, databases and
malformed `--node`/`--python` versions are rejected up front with the valid values. The environment variables `AGENT_SANDBOX_CONFIG`
(settings file) and `AGENT_SANDBOX_HOME` (folder for settings and history, default `~/.agent-sandbox`) do the same.
Commands that print data take `--json`.
