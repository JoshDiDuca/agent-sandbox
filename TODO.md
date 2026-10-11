# Handoff note for the next agent — read it, act on it, then DELETE this file

Written 2026-10-11 at the end of the session that rebuilt agent-sandbox (v3.0.0). The user asked for this note
and asked that whoever picks it up deletes it afterwards (`git rm TODO.md` in your first commit).

## Where things stand
- Everything the user asked for is implemented; see README.md for the feature list and CLAUDE.md for the layout.
- `npm test` passes (~120 checks: offline, security/attack tests, live ConPTY daemon + ptyhost + git guard).
- A real end-to-end guest boot (bundled runtime/main.js, not dry run) was run inside a Windows Sandbox with real
  toolchains: all tools on PATH, Node from .nvmrc via nvm, restart-in-place and exit codes verified.
- Two independent line-by-line reviews (host + guest) were done; all their findings were fixed (see git log).

## Not verifiable from inside a sandbox (check on the first real launch from the host)
1. `claude-sbx -t` from the HOST: the host -> guest TCP path across the Hyper-V NAT (attach only connects into
   the vEthernet subnet; ptyhost binds all addresses only when attach is enabled; guest firewall rule is LocalSubnet).
2. `--headless`: hiding/showing the real Windows Sandbox client window (logic verified on a normal window).
3. Windows Terminal as the sandbox window at logon (portable WT verified here; logon.cmd falls back to PowerShell).
4. `account use` with real Claude logins (swap + restart with --continue; caches remote-settings/policy-limits cleared).
5. claude-mem plugin behaviour inside the sandbox (its hooks need bun/uv, provided) and the db sync back.
6. CI on GitHub (windows-latest): self-test is informational (continue-on-error) per the user; release publishes a
   GitHub Release (agent-sandbox.tgz stable URL) + GitHub Packages (@joshdiduca/agent-sandbox) on v* tags.

## Gotchas learned the hard way
- Never spawn system programs by bare name on the host: use `SYSTEM.*` (src/shared/system.ts). cwd is the workspace.
- Anything the guest can write (data folder, workspace) is hostile: `assertNoLinks`, host-only state in
  <storage>\sync|run|accounts, zod-validate everything read from run/.
- PowerShell `.Replace()` batch edits corrupted files twice; use the Edit tool or a Node script that reports misses.
- C# must stay C# 5 (csc from .NET Framework); anonymous `delegate` to `new Thread` is ambiguous, use a lambda.
- nvm-windows 2.x ships no portable zip: the code falls back to the newest 1.x `nvm-noinstall.zip`.
- Rust GNU host needs MinGW (cpp toolchain) as linker; WinLibs UCRT build works (tested with a cc-crate build).
- Commander 15 needs Node 22.12+; the user's host Node is 22.0.0, so commander is pinned to 14.
- This conversation's transcript lives under C--Workspace; the new default guest path is C:\Workspace\<folder>,
  so use `claude --resume` (not --continue) to find it after the switch.
