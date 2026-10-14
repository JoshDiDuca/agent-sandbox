# Several projects

One Windows Sandbox can hold several of your projects, each with its own folder, tools, versions, databases,
`.sandbox-config.json` and environment. This page explains how that works. The commands are listed in
[commands](commands.md#several-projects), the settings in [configuration](configuration.md#several-projects-in-one-sandbox).

## What a project is

A project is the folder you start from (the launch folder), or any folder you add later. A **project root** is a folder
whose subfolders are projects (for example `F:\Code`, with `F:\Code\api` and `F:\Code\web` as projects). Roots are set
in `projects.roots`.

Only one Windows Sandbox runs at a time, and it fixes its mapped folders when it starts. So a project can join a
running sandbox only in the ways below.

## Adding a project to a running sandbox

From a folder the running sandbox does not have yet, `sandbox claude` (any agent, `start`, `exec`, `db`) adds it
without a restart when it can:

1. Inside a **project root** (`projects.roots`, mapped at every start): at once, also for folders created after the
   start.
2. On Windows 11 24H2+ with the updated Windows Sandbox: `wsb share` (untested; any error falls back to 3).
3. Otherwise you are offered a **restart** that maps it too. It lists the sessions that will end, keeps your files,
   tools, databases and logins, and reopens those sessions afterwards (each continuing its conversation). `--yes` skips the
   question; without a terminal it is never done without `--yes`.

The project is then set up on demand: its toolchains, versions, databases and its `.sandbox-config.json`, approved as
at a launch. Its sessions run with its own folder and environment. Inside the sandbox, `sbx-shell <project>` opens a
terminal in a project with its tools.

Starting an agent from another project while the sandbox runs adds that project in the same way. Tools that are already
installed cost nothing.

## Where a project appears inside the sandbox

A project is at the same place inside the sandbox whichever project started it, so git worktrees and Claude's project
history (both store absolute paths) keep working:

| The project is | Inside the sandbox (default) | With `guestWorkspace: "mirror"` |
|---|---|---|
| inside a project root, e.g. `F:\AgentProjects\app` with root `F:\AgentProjects` | `C:\Projects\AgentProjects\app`, also when it started the sandbox | `F:\AgentProjects\app` |
| anywhere else | `C:\Workspace\app`, also when mapped at boot by a restart or shared with `wsb share` | its PC path (a shared folder: `C:\Workspace\app`) |

The root decides: starting from `app` maps the whole root and opens `app` under it (no second mapping). Exceptions keep
the project's own `C:\Workspace\app` mapping, with a note at launch: a fixed `guestWorkspace` path, `readOnly` and
`workspaceFilter` (the root would show the folder unfiltered and writable). Two projects with the same folder name
get `C:\Workspace\app-2` for the second one. Adding a root moves its projects from `C:\Workspace\<name>` to
`C:\Projects\<root>\<name>` once ([git worktrees after a move](troubleshooting.md)).

Each mapped folder passes the same checks as a launch folder (no drives, your profile, system or tool folders).

## Consent

A project may need something that is fixed when a sandbox starts, or that only you may allow. You are asked, and nothing
is changed without your answer (or `--yes` for a restart).

**Joining a sandbox that lacks what the project needs.** Things that are fixed at boot (a `.wsb` device such as vGPU that
you allowed for the project, a larger fixed `memoryMb`, its approved mappings) cannot be added to a running sandbox.
When the project joins one started without them, each missing item is named and you choose:

- **Restart with them (sessions reopen and continue)**: lists the sessions that end, restarts, and reopens them, each
  continuing its conversation.
- **Continue without them**: join as the sandbox is.
- **Cancel**.

A project whose own settings are stricter than the running sandbox's (for example vGPU off while it is on) asks
"Join with the sandbox's settings?" instead; `--yes` accepts. Any agent can join this way: `sandbox codex` next to a
running Claude works the same.

Without a terminal it continues and prints the restart command. A sandbox that starts with several projects (a restart,
`--session`, `projects.all`, the known projects in your roots) boots with what each of them wants and you allowed. A
device turned on that way is on for every project in it (the launch says so), unless the launch folder's own
`.sandbox-config.json` switched it off. Unapproved project files add nothing.

**Stricter protections.** Machine-wide protections (git access, network, the LAN block, clipboard and the other `.wsb`
settings, read-only) are fixed when the sandbox starts. A project that needs a stricter one cannot join a sandbox that
has a looser one, and says which setting. A project that asks for a looser one simply gets the sandbox's stricter value.
Nothing is ever loosened. A project file may loosen a protection only if you allow it, once for that project file (see
[project settings](configuration.md#project-settings)).

**Folders outside the project.** A project's `.sandbox-config.json` may map folders outside the project only as
`projects.allowOutsideMappings` in **your** settings allows (`"ask"` by default: asked once per project file and folder
at an interactive launch, never by `--trust-config`; `true` or `false`). How the approval works is in
[project settings](configuration.md#project-settings). "Outside" is decided where the folder really is (`%VARIABLES%` expanded, links followed). Drives, your profile and this
tool's own folders are never mapped, and no mapping lands on a folder the sandbox keeps for itself.

**Restarts.** A restart that adds a project only ever happens with your consent: a prompt, or `--yes`.

## Commands

`sandbox projects` manages which projects are mapped at every start, and the folders of your roots. The full table is in
[commands](commands.md#several-projects):

- `sandbox projects` (or `list`): the projects you have started, whether they are mapped at the start, and which are in
  the running sandbox.
- `choose`, `all on|off`, `exclude <folder>`, `include <folder>`: which known projects are mapped at every start
  (`projects.all`).
- `add <folder>`, `remove <folder>`: your known projects. Removing forgets a folder; its files are never touched.
- `roots [list|add|remove <folder>]`: folders whose subfolders are projects, mapped at every start.

The settings behind these (`projects.roots`, `projects.all`, `projects.exclude`, `projects.askToAddRoot`,
`projects.declinedRoots`, `projects.allowOutsideMappings`, `projects.wsbShare`) are described in
[configuration](configuration.md#several-projects-in-one-sandbox). When you start a project whose parent is not a root,
`projects.askToAddRoot` (on by default) asks once whether to add that parent as a root. Answers are saved: yes adds it, and
no is remembered in `projects.declinedRoots` (not asked again). Answering never turns `askToAddRoot` off.

## Adding folders to a running sandbox (`wsb share`)

Adding a folder to a **running** sandbox needs Windows 11 24H2+ with the updated Windows Sandbox (`wsb share`, untested).
On older Windows, folders inside a project root open instantly; anything else offers a restart (your files, tools,
databases and logins are kept; the sessions can be reopened).

To get `wsb`: Settings > Windows Update, turn on "Get the latest updates as soon as they're available" (or use the
Windows 11 Installation Assistant), then update Windows Sandbox from the Microsoft Store. Check with `wsb --version`;
`sandbox doctor` says whether it is found.

## Security

**Every project mapped into a sandbox is visible to every agent in it**, read and write: the launch folder, every folder
inside your `projects.roots`, every project mapped with `projects.all`, and every project added while it runs. An agent
you start for project A can read and change project B. Keep untrusted repos out of your roots and out of `projects.all`
(`sandbox projects exclude <folder>`), or give them their own sandbox and `storage.dataName`.

- Only your own config can map more folders. A project's `.sandbox-config.json` cannot set `projects.*`.
- Every mapped folder passes the launch-folder checks (no drives, your profile, system or tool folders).
- The repo guard covers every project the sandbox can write. A project that appears inside a root after the start has
  no "before" picture, so any git hook, program-running git config (`core.hooksPath`, `core.fsmonitor`, ...) or planted
  command in it is neutralised as if the sandbox had added it.
- `wsb share` is used only to add a folder to the running sandbox. Any error falls back to the restart offer.
- Restarts that add a project need your consent (see above).

More on the rest of the sandbox's protections: [security](security.md).
