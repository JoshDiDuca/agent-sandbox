# agent-sandbox overhaul — requested work

Everything is done by the scripts at boot (the sandbox is disposable; only the workspace and `C:\AgentData` persist).
"Verified here" = exercised for real inside a Windows Sandbox during development. "Needs host" = needs a real
Windows Sandbox started from a host PC, which cannot be done from inside one.

| # | Request | Status |
|---|---------|--------|
| 1 | Clean-code overhaul (modules, arrow functions, lodash on host side, strict tsc incl. unused checks) | done |
| 2 | npm global package (6 bins + programmatic API), user config in `~/.agent-sandbox/` | done, verified here (pack + global install) |
| 3 | Windows Terminal as the sandbox window from the first second (host pre-downloads portable WT) | done; download, launch and new-tab verified here |
| 4 | `--headless` (default off) | done; hide/show verified on a real window; needs host for the real sandbox window |
| 5 | `sbx-show` (+ `agent-sandbox hide`) | done |
| 6 | `claude-sbx --terminal` / `attach`: sandbox session on the host terminal with full input | done; ConPTY bridge, repaint, input, restart verified here; host->guest network path needs host |
| 7 | nvm-windows in the sandbox, default from `--node` / `.sandbox-config.json` / `.nvmrc` / `.node-version` / host version | done, verified here (install, `nvm use`, extra versions) |
| 8 | Desktop personalisation copied from the host registry | done; capture + .reg import verified here |
| 9 | Rust/cargo, Python 3 + 2, C#/.NET, plus C/C++ (MinGW), Bun, uv | done, verified here (cargo build incl. C dep, pip2/pip3, dotnet run) |
| 10 | Multiple Claude accounts, default, `--account`, switch mid-session (swap + restart with `--continue`) | done; logic tested; live switch needs a real login |
| 11 | Full Git for Windows with bash (host copy or PortableGit) | done, verified here |
| 12 | All conversation/prompt history in and synced back (path-translated) | done, tested |
| 13 | claude-mem to and from the sandbox (plugin, data, Bun/uv) | done; sync logic tested; plugin behaviour needs host |
| 14 | README, self-test, CI + release workflow, npm publish path | done |
| 15 | Final clean pass, extra commands (status, exec, restart, stop, logs, clean, sync, sessions, config) | done |
| 16 | Multiple sessions in one sandbox (new tab per session) | done; daemon verified live here |
| 17 | Safe host <-> sandbox channel (4 request kinds, validated data, subnet-pinned attach) + API | done, tested |
| 18 | Auto-cleanup of launches > 7 days, old logs, leftovers | done, tested |
| 19 | Tiny sandbox manifest for agents via managed CLAUDE.md (user + project CLAUDE.md untouched) | done, tested |
