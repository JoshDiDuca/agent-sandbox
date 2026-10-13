# Security

The sandbox is treated as hostile and your PC as precious.

## Containment

- The agent writes only your project folder (and the other projects you map, see [several projects](#several-projects)) and its own storage.
- Drive roots, your user profile, system folders and this tool's folders are refused as workspaces.
- Your LAN is blocked from inside the sandbox (DNS excepted). `sandbox.networking: false` cuts all network access.
- vGPU is off by default.

## Secrets

Before anything from your Claude settings is copied in, these are stripped:

- `settings.json` `env`
- credential helpers (`apiKeyHelper`, `awsCredentialExport` ...)
- every MCP server's env, headers, URL and arguments

Removed:

- AWS, Azure, Google Cloud and Cloudflare credentials, plus hosting, CI, registry, payment and AI API keys
- database URLs
- anything named `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `*_KEY` or `*PROD*`
- values that look like keys, whatever they're called

`secrets.allow` lets named variables through, and `secrets.patterns` adds more to strip. A project file cannot weaken
these settings. The launch output lists what was kept back, and warns about files like `.env` or `*.pem` that the agent
can read because the whole folder is mapped.

## Nothing runs on your PC

- Host and sandbox talk through small JSON files. The sandbox can ask for four things (start a session, run a command,
  restart, ping), and everything it writes back is validated and size-capped.
- Text from the sandbox loses its escape sequences before it reaches your terminal. When you attach, the session's
  output passes a filter that drops clipboard writes (OSC 52, however they are split or disguised), terminal macros
  and other control strings; colours, titles, links and progress pass.
- What the sandbox adds to a project that tools on your PC would run by themselves is moved to
  `agent-sandbox-quarantine`: git hooks and program-running git config (also in submodules and nested repositories),
  commands planted in the project root, Claude Code hooks, helper commands and MCP servers (`.claude/settings*.json`,
  `.mcp.json`), VS Code folder-open tasks and program paths, and `.envrc`. Ordinary edits to those files stay.
- Links the sandbox plants are never followed.
- Files it writes are read with bounded effort.
- Attaching from your terminal connects only into the sandbox's Hyper-V network, with a per-session token.

## Downloads

Toolchain, database and tool downloads are checked against the SHA-256/SHA-512 their publisher lists, and a mismatch
deletes the file. Some sources list none (for example a script fetched from a vendor's site). By default those are
still allowed. Set `downloads.requireChecksum` to `true` to refuse any download that has no published checksum; the
failure names the file and the setting. A project's `.sandbox-config.json` can turn this on but never off. The
installer (`install.ps1`) similarly refuses a release package with no listed SHA-256 unless `WDS_ALLOW_UNVERIFIED=1`.

## Coming back

- Only data files return with history. claude-mem returns its database only.
- Git hooks and dangerous git config added inside the sandbox are quarantined before your own git can run them.
- So are executables planted in the project under names you type there (`node.exe`, `sandbox.cmd` ...).
- `sandbox status` lists anything that was quarantined.

## GitHub CLI

`gh` is never given your PC's login (`GH_TOKEN`, `GITHUB_TOKEN` are stripped) and is only installed with git access
`full`, because it can push and merge through the GitHub API. A login made inside is kept in `C:\AgentData\state\gh`.

`ssh` comes with Git, but no keys are copied in and your LAN is blocked, so deploys stay on your PC.

## Agent commands (Beta)

Off by default. When on, it adds one folder (inside this tool's storage) to the start of your own PATH, holding only
forwarding commands it wrote; `off` removes them and the entry. A repo's `.sandbox-config.json` cannot turn it on.

## Git access

`provisioning.git.access`, settable per project:

| | |
|---|---|
| `full` (default) | git as normal |
| `readonly` | status, log, diff, show, blame and listing branches/tags only |
| `none` | no git; the repository is invisible to it |

## Several projects

**Every project mapped into a sandbox is visible to every agent in it**, read and write: the launch folder, every
folder inside your `projects.roots`, every project mapped with `projects.all`, and every project added while it runs.
An agent you start for project A can read and change project B. Keep untrusted repos out of your roots and out of
`projects.all` (`sandbox projects exclude <folder>`), or give them their own sandbox and `storage.dataName`.

- Only your own config can map more folders; a project's `.sandbox-config.json` cannot set `projects.*`.
- Every one of them passes the launch-folder checks (no drives, your profile, system or tool folders).
- Machine-wide protections (network, LAN block, git access, clipboard and the other `.wsb` settings) are fixed when
  the sandbox starts. A project needing a stricter value cannot join a sandbox that has a looser one (you are told
  which setting); a project asking for a looser one gets the sandbox's stricter value. Nothing is ever loosened.
- The repo guard covers every project the sandbox can write. A project that appears inside a root after the start
  has no "before" picture, so any git hook, program-running git config (`core.hooksPath`, `core.fsmonitor`, ...) or
  planted command in it is neutralised as if the sandbox had added it.
- A restart that adds a project only ever happens with your consent (a prompt, or `--yes`).
- `wsb share` (Windows 11 24H2+) is used only to add a folder to the running sandbox; it is untested, and any error
  falls back to the restart offer.

## Shared tools

`C:\AgentData` (tools and databases) is shared by every project's sandbox. For a repo you don't trust, give it its own
data set with `storage.dataName`.

Inside the disposable sandbox only, the "Do you want to run this file?", SmartScreen and firewall prompts are off.

Review what the agent writes like a contribution from a stranger.
