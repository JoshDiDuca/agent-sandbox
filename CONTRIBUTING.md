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

`npm test` only runs inside a Windows Sandbox or on GitHub Actions (it refuses on a normal PC). Use `sandbox start` and
run it there (`sandbox self-test [suite...]` is the same command, hidden from `--help`); `npm run build` works anywhere. Running one suite, and the test helpers, are in
[docs/development.md](docs/development.md#tests).

Developing this tool with an agent inside its own sandbox? Install a copy (`npm run install:global`), never a link.
See [docs/development.md](docs/development.md).

## Where things are

[CLAUDE.md](CLAUDE.md) has the code layout, the coding standard, the rules and the traps we already fell into. Read it
first. In short:

- New setting: schema in `src/core/schema/`, the default in `DEFAULTS` (`src/core/config/defaults.ts`), then
  `config.example.json` and the docs.
- New feature or command: define it once in `src/app/features/<area>` (an operation, query or view with a CLI hint);
  the command line, the menu and the web UI render it ([shared-core.md](docs/design/shared-core.md#how-to-add-a-feature-walkthrough)).
  Commands not moved yet live in `src/cli/manifest.ts`. Then [docs/commands.md](docs/commands.md).
- Every change gets a test in `src/selftest/`.

## Pull requests

1. Keep each pull request to one change.
2. `npm test` passes, and `npm run lint` and `npm run format:check` pass.
3. Docs and `config.example.json` match the code.
4. Describe what changed and why. Do not bump the version: maintainers do that when releasing.

Security problems: do not open a public issue. See [SECURITY.md](SECURITY.md).
