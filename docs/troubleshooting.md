# Troubleshooting

Start with `sandbox repair`, then `sandbox doctor` and `sandbox logs -f`.

## What doctor checks and repair can fix

`sandbox doctor` and `sandbox repair` run the same checks, grouped under headings, one line each as it finishes. A line that is not fine says what it means and what to do. A check that takes more than 20 seconds (a stuck Windows tool, no network) is skipped with "took too long" and the rest go on.

- `sandbox doctor` only looks. When some problems can be fixed it asks "N problems can be fixed. Fix them now?" (`--fix` does it without asking; without a terminal it only tells you).
- `sandbox repair` lists exactly what it will change, asks once (`--yes` skips the question), makes the changes, looks again to see they worked and prints "fixed", "needs you" or "still not right" for each. The log of what it found and changed (before and after) is `<storage>\logs\repair-<time>.log`; its path is printed at the end. Repair never deletes your settings, logins, history or projects: it removes leftovers and links the sandbox made, and moves pointers back.
- `--json` for both prints the results (`id`, `group`, `status`, `detail`, `fixable`, and after a fix what changed). With `--json`, repair changes nothing unless you add `--yes`.
- Menu: Maintenance > Health > "Run the checks and fix what can be fixed" runs `sandbox repair` on the normal screen.

| Group | Check | Fixed by repair |
|---|---|---|
| This PC | Windows, edition, CPU virtualization, memory, Node.js, a Windows restart waiting | no (it says what to turn on) |
| Install | managed or npm install and its scope | no |
| | `install.json` readable | no (run the installer again) |
| | `active-version` and `active-node` name installed folders | yes: points them at the newest complete version and Node (nothing is deleted) |
| | the commands (shims) in `bin` exist and read the active version | yes: rewrites them |
| | `bin` is on the right PATH (yours, or the PC's for an all-users install) | yours: yes; the PC's: no (run the installer in an admin PowerShell) |
| | all-users: the automatic-update task matches `install.json` | yes when this is an admin terminal, else it gives the command |
| | all-users: a second install for just you next to it | no (shows the uninstall command) |
| | every `sandbox`, `agent-sandbox` and `claude-sbx` on the PATH (the PC's, then yours): which copy runs, and the exact command that removes each other one | no (it never runs them and never deletes; see "The wrong version runs") |
| | the old `agent-sandbox` npm package, or an npm copy next to the managed install | no (shows the `npm uninstall -g` command) |
| | all-users: you can read the settings for the PC, and you are in the group Agent Sandbox Users | no ("sign out and in", or the command an admin runs) |
| Data folder | where it is, that it is not a link and that you can write there | no |
| | free disk space | no |
| | your data still in the old per-user folder, or in another known folder, or in two (a move that stopped half way) | no: points at `sandbox storage move` / `sandbox storage use`; nothing moves without you |
| | all-users: your data folder is private to you, SYSTEM and Administrators | yes: makes it private. An empty folder is changed on its own; a folder with files is changed file by file, which takes minutes on a large one (repair says so and waits up to 30 minutes) |
| | all-users: the group has no leftover permissions on your folders while nothing is shared; the run folder is open to the group while one is | yes: removes or restores those entries only |
| | links made inside the data folder | yes: removes the links without following them |
| | interrupted downloads, half-installed toolchains, a damaged `resolved-versions.json` | yes: removes them (the next start redoes them) |
| | **(Beta)** contained storage, only when it is on or an image exists: the image is there, what is recorded as mounted is really mounted, and the images and mounts folders are private. See [Contained storage](#contained-storage-beta) | yes: dismounts a mount nothing uses (Windows asks for permission), corrects the record, makes the folders private |
| Settings | `config.json` loads | yes when an update saved a good copy: shows what differs, puts it back, keeps the broken file as `config.json.broken-<time>` |
| | updates to your saved settings are pending | yes: runs them (with a backup) |
| | project files you approved that changed since | no (explains: the next launch there asks again) |
| Sandbox | `WindowsSandbox.exe` and the Windows Sandbox feature | no (`sandbox setup`) |
| | a sandbox running that is not yours or has no status files | no |
| | run state, session and request files, and the hidden-window list of a sandbox that is gone | yes: clears them |
| | records of sync watchers that are gone; watchers still running with no sandbox | yes: removes the records and stops the orphans (only a Node program whose record has been quiet for 10 minutes) |
| | all-users: sharing records of sandboxes that are gone | yes: removes them |
| | launch folders older than 7 days | yes: removes them |
| | `HostTools.exe` built; the conpty and Windows Terminal downloads whole | yes: builds it; removes an incomplete download |
| Agents & tools | the default agent is configured; each agent's saved login is in use | no (`sandbox account use`) |
| Network | a proxy variable that makes sense; github.com reachable | no |

A fix that touches the folders of a running sandbox waits until it is closed (the result says so).

| Problem | Try |
|---|---|
| Windows Sandbox missing | `sandbox setup` checks the edition and virtualization, and offers to turn it on |
| "A Windows Sandbox is already running" | Only one runs at a time: `sandbox status`, then `sbx-show` or `sandbox stop` |
| A toolchain failed on first start | The rest still works. `sandbox repair` removes the half-install, so the next start retries |
| Install commands fail | `npm install -g` needs Node.js 20+; the one-liner installs it. Check your internet and try again |
| The first start is slow | Expected once: it downloads what the project needs. Later starts reuse it |
| Disk filling up | `sandbox data` shows what is big; `sandbox data clean <part>` frees it |
| Malwarebytes (or another antivirus) reports "Trojan.Loader" for `Windows Development Sandbox.lnk` | A false positive: the Start menu shortcut starts the `sandbox.cmd` script, which antivirus heuristics read as a loader. Only the shortcut is affected; leave it in quarantine. Installers from 1.8.0 make no shortcut unless you pass `-StartMenuShortcut`, and remove the old one |
| Cannot select or copy text in an agent's session | The agent takes the mouse: hold Shift while you drag to select (Windows Terminal), then Ctrl+C or right-click. The agent's own copy works in the sandbox's terminal, and in `sandbox attach` while `sandbox.clipboard` is on (the default) |
| A command is "not recognized" in a new terminal tab | Every shell rebuilds its PATH from the machine and user PATH at start. Run `sbx-agent list` for agents (a missing one installs on first use). `echo $env:Path` / `echo %PATH%` shows the PATH; `C:\nvm\bin\pathsync.exe` prints the one a new shell should have |
| Codex says its local database is damaged (disk I/O error, code 8714) | SQLite cannot run in the shared data folder. Codex now runs its databases from the sandbox's disk (`harnesses.codex.localState`); a config that pins its own `harnesses.codex` needs that key |
| Config errors | The message names the key and the problem; `sandbox config show` prints the effective config |
| pnpm, Bun or npm workspaces fail with EPERM | Mapped folders allow no symlinks; see [mapped folders](toolchains.md#mapped-folders) |
| A database didn't start | Check `sandbox logs`. Turn it on explicitly with `databases.<name>.enabled: true` |
| Can't delete `toolsmsvc` | MSVC's telemetry helper (`vctip.exe`) is removed on each start so nothing keeps it locked; if a delete still fails, close the sandbox first |
| MSVC is not installed | Set `toolchains.msvc.acceptLicense: true`; the launch output says when a project would use it |
| The sandbox was gone in the morning | The next launch says why, from Windows' own logs, and a crash report (what Windows logged, this PC's blue screens, the last memory samples) is kept in `<storage>\logs\crashes`. Inside the sandbox, `C:\AgentData\logs\memory-*.log` samples memory every 30 s (every 5 s when it is high) and `memory-pressure.txt` says ok / high / critical. Rust links with lld and only a few links run at once (`toolchains.rust.linker`, `.linkSlots`); fewer builds at once (cargo `build.jobs`) helps too. If this PC also blue-screens under load, test its memory (Windows Memory Diagnostic, or turn off XMP/EXPO for a while). Switching user does not close it; signing out, restarting or sleep does. The launch and `sandbox doctor` warn when Windows Update is waiting to restart: restart first, or pause updates. `sandbox.keepAwake` (on by default) stops the PC from sleeping while a sandbox runs. Conversations are kept: `sandbox resume` starts the sandbox again and reopens its sessions, each in its own conversation (`resume.sessions` does it at the next launch; `resume.restartAfterCrash` starts it by itself after a crash, at most 3 times in 6 hours), or `/resume` in Claude |
| A project's `vGpu: true` (or another looser setting) is not used | A project file may only tighten your settings. Start it once from an interactive terminal and answer yes to "Allow these for this project?", or set it in your own settings. `sandbox config check` in the project shows what is allowed |
| "maps N folders outside the project" | The project's `.sandbox-config.json` maps folders from elsewhere on your PC (a repo ships that file). Start it from an interactive terminal and answer yes, or set `projects.allowOutsideMappings` to `true` in your settings. `sandbox config check` previews every folder: where it appears and whether it is allowed |
| "mapped folders cannot be used" | Each folder is named with why (a relative `guest`, a folder the sandbox keeps for itself such as `C:\Users`, or one already in use). Leave `guest` out to use the same path as on your PC, or give a full path such as `C:\Games\<name>` |
| Node.js still running after the sandbox closed | The background watcher stops within 3 minutes of the sandbox closing, and the installer stops one left by an older version. With an older version: end `node.exe` in Task Manager while no sandbox runs |
| The sandbox slows my PC down | Lower `sandbox.cpuLimit` (e.g. `50`) and `sandbox.maxMemoryPercent`; they apply from the next start |
| The mouse wheel or a click does nothing in an agent session | Clicks and the wheel reach the agent as in a normal Windows Terminal tab (in the sandbox and with `sandbox attach`). While the agent tracks the mouse the wheel goes to it; Shift+wheel scrolls the terminal and Shift+drag selects text. `provisioning.conpty.enabled: false` uses Windows' own pseudo console instead (no mouse for the agent, the wheel always scrolls) |
| No Vulkan | Windows Sandbox has none: `toolchains.mesa.vulkan: true` gives software Vulkan, `sandbox.vGpu: true` Direct3D 12 |
| winget is missing | Windows Sandbox has no winget; everything here installs portably, and real installers go in a hook |
| `self-test` or `npm test` refuses to run | By design: it starts real processes and creates files and links, so it only runs inside a Windows Sandbox (`sandbox start`) or on GitHub Actions |
| `sandbox launch` says you are inside the sandbox | Commands that control the sandbox run from your PC, not from inside it |
| Check a project file | `sandbox config check` validates `.sandbox-config.json` and lists what it changes |
| Another project "needs a restart" | Windows Sandbox cannot add folders while it runs. Folders inside a project root open at once: `sandbox projects roots add <parent folder>` (from the next start). On Windows 11 24H2+ with the updated Windows Sandbox, `wsb share` adds them live (untested) |
| Getting `wsb` | How to update Windows Sandbox and check it with `wsb --version` is in [several projects](projects.md#adding-folders-to-a-running-sandbox-wsb-share); `sandbox doctor` says whether it is found |
| "<project> wants vGPU and 2 folders (...), but this sandbox started without them." | Those are fixed when Windows Sandbox starts. Choose "Restart with them", or run the printed `sandbox claude --workspace "<folder>" --yes`. To have them in every sandbox, set them in your own settings (`sandbox.vGpu`, `mappings`) |
| "needs stricter protection than the running sandbox has" | A project asking for stricter git access, no network, the LAN block or read-only cannot join a sandbox started with looser settings (they are machine-wide). Stop it and start from that project |
| Git worktrees "prunable", or Claude will not resume an agent in its worktree | Git and Claude store absolute paths. A project is now at the same place inside whichever project starts the sandbox (`C:\Projects\<root>\<name>` in a root, else `C:\Workspace\<name>`, see [several projects](projects.md#where-a-project-appears-inside-the-sandbox)); up to 1.4.0 a project in a root was at `C:\Workspace\<name>` when it started the sandbox itself. Worktrees made at the old place need one repair, inside the sandbox in the main checkout: `git worktree repair <each worktree folder>` (or `git worktree repair` from inside each worktree), then resume. The same applies after adding a root, changing `guestWorkspace` or turning `mirror` on. History synced from your PC follows the new place; conversations kept only inside the sandbox stay under the old folder's name in Claude's `projects` folder |
| "A Windows Sandbox started by alice is already running (Windows allows one per PC)" | Windows runs one sandbox at a time. If alice shares it, use it with `sandbox attach` or `sandbox exec`; otherwise start yours after it stops |
| The sandbox window is not on my screen | It is on the desktop of the user who started it. Switch to their account to see it; you can still use its agents with `sandbox attach` when they share it. Signing that user out closes the sandbox |
| Added to Agent Sandbox Users but sharing does not work | Group membership counts after the user signs out and in once |
| `sandbox update` says it needs admin rights | The install is for everyone and only administrators change it. Run it in an admin PowerShell (right-click Start, Terminal (Admin)) |
| "Update to X failed; still on Y" | Your version is unchanged. `sandbox update` shows the reason; `sandbox update --rollback` goes back to the version before the last update. The failed version is not tried again, only a newer one |
| Hooks quarantined in a project root | A project that appeared in a root after the start has no baseline, so its git hooks and `core.hooksPath` count as added inside the sandbox. `sandbox status` lists them; move them back if they are yours |
| "Could not change the folder permissions ... ETIMEDOUT" (every launch fails; an all-users install with sharing on) | 1.5.0 rewrote the permissions of the storage folder, the data folder, the data set and its run folder on every launch, and Windows re-applied each change to every file below it. With toolchains in your data (hundreds of thousands of files) that took longer than the time limit. Fixed after 1.5.0: an entry that changes nothing is not written, a folder's own entry is written without touching what is inside it, and a launch with sharing off skips the step when the group has no entry on your folders. `sandbox update` to get it; until then the launch cannot start. The first install or update afterwards may still take a few minutes once, to take away an extra permission entry (next row) |
| The folders `%ProgramData%\AgentSandbox`, `users` or `active` ask "You don't have permission to access this folder" in Explorer | Do not press Continue: Explorer then adds a full-control entry for you to the folder, and the next install or update has to remove it again, which walks every user's storage (minutes, once). Look at the folders from an admin PowerShell instead, or use `sandbox storage show` |
| The wrong version runs, or a fix is not there after an update | More than one copy of the commands is on the PATH, and the first one runs: the PC's PATH comes before yours, so an install for just you never runs next to one for everyone, and an npm copy (`npm run install:global`) can sit in front of the installed one. `sandbox --version` says where the running copy is. `Get-Command sandbox -All` lists every copy in the order Windows finds them (also try `agent-sandbox` and `claude-sbx`). `sandbox doctor` shows the same list under Install, says which one runs and prints the exact command that removes each other one; it never deletes anything itself. Usual fixes: `npm uninstall -g windows-development-sandbox` (an npm copy), `install.ps1 -Uninstall -Scope CurrentUser` (the per-user install), `Remove-Item -Recurse -Force C:\Scripts\agent-sandbox` and take its `bin` off your PATH (the old layout). The installer offers to remove the per-user install and the old layout when you install for everyone |
| "Not shared: sharing.otherUsers is on, but no all-users install was found" | Sharing needs the install for everyone (the group and the shared folders come from it). Any copy of the program finds it in `%ProgramFiles%\WindowsDevelopmentSandbox`; if there is none, install with `-Scope AllUsers` |
| "There is already an install for everyone on this PC; an install for just you would never run" | The installer refused `-Scope CurrentUser`. Keep using the install for everyone, or remove it first in an admin PowerShell with `-Uninstall -Scope AllUsers` (your data is kept) and install again for just you |

## Contained storage (Beta)

For `storage.contained: "vhdx"` ([configuration](configuration.md#contained-storage-beta)). **Beta, not yet tried on a real PC**: if something here goes wrong, `sandbox storage contained off` is the way back, and `sandbox doctor` says what it sees.

| Problem | What to do |
|---|---|
| "Contained storage is still mounted from an earlier sandbox" (a line at the start of a command), or doctor says "the image is still mounted ... and nothing uses it" | A sandbox ended (or crashed) without dismounting. `sandbox repair` dismounts it (Windows asks for permission). The image and everything in it are fine. By hand: in an admin terminal run `diskpart`, then `select vdisk file="<storage>\images\<name>.vhdx"` and `detach vdisk` |
| Doctor says "the record says the image is mounted, but it is not" | Only the bookkeeping file `<storage>\mounts\state.json` is out of date. `sandbox repair` corrects it; nothing is mounted or dismounted |
| "The image is still attached (something is using it)" / "the image is in use" when dismounting | A program has a file open in the image (Explorer or a terminal in `<storage>\mounts\<name>`, a scanner, an editor). Close it and run `sandbox repair` again. The sandbox must be closed too: a dismount is refused while Windows Sandbox runs |
| "The image is attached somewhere else" | It was attached with Disk Management or another tool (maybe with a drive letter). Detach it there (or with the diskpart commands above), then start again |
| Windows did not give permission (the prompt was declined or closed) | The mount and the dismount each need one Windows permission prompt. Run the command again and choose Yes. A launch cannot start without it; turn the feature off with `sandbox storage contained off` if you do not want the prompts |
| "The mount folder is not empty" / "is a mount point already" | Something is in `<storage>\mounts\<name>` that this tool did not put there, or another disk is mounted there. Nothing is changed: look at the folder, remove what does not belong (when it is a mount point, detach that disk), then try again |
| "The image is missing" | The `.vhdx` file under `<storage>\images` was moved or deleted. Put it back, or `sandbox storage contained off` and then `on` for a new empty image (tools are downloaded again) |
| "The image is bigger than the limit" / "differencing disk" / "not yours" | The script refuses images it did not make: a larger size than `storage.containedMaxGb`, one that depends on a parent file, or one owned by another user. Nothing is changed. Raise `containedMaxGb`, or use the image you made |
| A file `main.vhdx.failed-<time>` appears in `images` | The first creation did not finish; the unfinished image was renamed, never deleted. It holds nothing of yours: delete it when you like |
| "Contained storage cannot be used: ... inside a Windows Sandbox" | Disk images cannot be mounted in a sandbox. Run the command on your PC |
| `sandbox storage move` says the contained storage is mounted | Dismount first (`sandbox repair`, or close the sandbox and wait for the watcher to let go). A move would otherwise copy into the image |
| `sandbox data` shows little or nothing after turning it on | It still reads the plain data folder; the tools, state and logs are in the image. Look inside while it is mounted, or turn it off to get them back as folders |
