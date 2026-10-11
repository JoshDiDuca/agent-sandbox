# Security

## Reporting a problem

Please report security problems privately, not in a public issue.

- Use GitHub's **Report a vulnerability** button on the repository's Security tab
  (<https://github.com/JoshDiDuca/windows-development-sandbox/security/advisories/new>).
- Include what you did, what happened, and the version (`npm ls -g windows-development-sandbox`).

You should get a first answer within a few days. Fixes ship as a normal release, with credit if you want it.

## What counts

The tool treats everything inside the sandbox as hostile and your PC as precious. These are security bugs:

- Anything the sandbox can do to run code on your PC, or to read or change files outside what it was given.
- Credentials (Claude login, API keys, tokens) reaching the sandbox when settings say they should not.
- A project's `.sandbox-config.json` loosening a protection, or taking effect without your approval.
- A way around the LAN block, the git access modes, or the refusal to use drive roots, your profile or system
  folders as a workspace.
- Unsafe handling of text, files or links that come back from the sandbox.

Not covered: flaws in Windows Sandbox itself (report those to Microsoft), and what an agent does inside the folder you
gave it. The agent can read and change that folder.

## The model in brief

- The sandbox gets your project folder and its own storage, and little else.
- Credentials are stripped before anything is copied in.
- Your LAN is blocked from inside.
- The sandbox talks to the PC through small, validated JSON files. The PC never executes, trusts or follows links in
  what the sandbox writes.
- A project file can only make protections stricter.

Details: [docs/security.md](docs/security.md).

## Supported versions

Only the latest release gets fixes.
