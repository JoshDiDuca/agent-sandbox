# Commands

`sandbox` (also `windows-development-sandbox`) is the command. `sandbox <agent>` starts any configured agent;
`claude-sandbox`, `codex-sandbox` and `gemini-sandbox` are shortcuts. The old names `agent-sandbox`, `claude-sbx`,
`codex-sbx` and `gemini-sbx` still work for now.

## The menu

`sandbox` with no arguments opens a menu:

1. **Repeat last**: the last command you ran, typed or from the menu
2. Start the default agent, or pick another (shows which are already installed)
3. Start a sandbox without an agent
4. Sandbox, sessions, accounts, data, diagnostics, configuration
5. **Settings**: every setting with its value and description, changed and saved from the menu

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

Anything else goes to the agent: `sandbox claude --continue`. If an agent has a flag with the same name as ours, use
`--sbx-<flag>` for ours or put the agent's flags after `--`.

## A running sandbox

| | |
|---|---|
| `sandbox attach [id]` | show a session in this terminal (`Ctrl+]` detaches) |
| `sandbox sessions` | sessions and who is attached |
| `sandbox status` | overview |
| `sandbox db [start\|stop <name>]` | list, start or stop databases in the running sandbox (`sbx-db` inside) |
| `sandbox exec -- <cmd>` | run a command inside and print its output (`--timeout`, `--workspace`) |
| `sandbox restart` | restart agents in place; they resume their conversation |
| `sandbox stop` | shut down (history syncs back) |
| `sandbox show` / `hide` | show or hide the window (`sbx-show`, `sbx-hide`); hidden, it keeps running |

Sessions can be shown in the sandbox and in your terminal at the same time. Closing a tab never stops a session; only
the agent exiting does.

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
| `sandbox self-test` | the built-in tests |

## Accounts and config

| | |
|---|---|
| `sandbox account list` | Claude accounts |
| `sandbox account save <name> [--from-host]` | save the sandbox's (or this PC's) login |
| `sandbox account use <name>` / `default <name>` / `remove <name>` | switch now (Claude restarts and continues) / for new sandboxes / delete |
| `sandbox config show` / `path` / `init` / `schema` | effective config / its file / create it / editor schemas |
| `claude-host` | Claude on this PC, **not** sandboxed, with its own profile |
