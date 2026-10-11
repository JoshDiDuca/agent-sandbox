# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Set up

You need Windows 10/11 Pro, Enterprise or Education, and Node.js 22 or newer (CI also tests 22.0.0).

```powershell
git clone https://github.com/JoshDiDuca/windows-development-sandbox
cd windows-development-sandbox
npm ci            # installs and builds
npm test          # must end with ALL TESTS PASSED
```

`npm test` only runs inside a Windows Sandbox or on GitHub Actions (it refuses on a normal PC). Use
`sandbox start` and run it there; `npm run build` works anywhere.

`npm run build` runs tsc, bundles the sandbox-side code and regenerates `schemas/*.json`. Commit the schemas when
setting descriptions change.

To run one area while you work, give the suite name (several allowed, or comma separated). `npm test` builds first;
the second form skips the build:

```powershell
npm test -- config
node dist/bin/agent-sandbox.js self-test cli,workspace
```

Each `src/selftest/*.test.ts` file is one suite (listed in order in `src/selftest/index.ts`; a wrong name prints the
list). The live tests drive ConPTY and real processes: they poll with long deadlines instead of sleeping, so a failure
is real, and it prints the screen and daemon log it saw. See [docs/development.md](docs/development.md#tests).

Developing this tool with an agent inside its own sandbox? Install a copy (`npm run install:global`), never a link.
See [docs/development.md](docs/development.md).

## Where things are

[CLAUDE.md](CLAUDE.md) has the code layout, the rules and the traps we already fell into. Read it first.

## Rules in short

- TypeScript, arrow functions, lodash where it shortens code, zod for every shape read from disk.
- The sandbox is hostile. Code on the PC never runs, follows or trusts what the sandbox wrote.
- Messages are short, plain English. Errors the user can fix use `fail(message, fix)`.
- New settings go in `src/core/schema.ts` and `DEFAULTS`, plus `config.example.json` and the docs.
- New commands go in `src/cli/manifest.ts` (flags and menu both come from it), plus `docs/commands.md`.
- Add a test in `src/selftest/` for what you change. Tests may only use temp folders they create: never your real
  config, the registry, PATH, your profile or global git config.
- Keep dependencies old enough for Node 22.0.0.

## Pull requests

1. Keep each pull request to one change.
2. `npm test` passes.
3. Docs and `config.example.json` match the code.
4. Describe what changed and why. Do not bump the version: maintainers do that when releasing.

Security problems: do not open a public issue. See [SECURITY.md](SECURITY.md).
