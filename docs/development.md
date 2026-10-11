# Development

```powershell
npm install               # dependencies + build
npm test                  # offline, security and live ConPTY/daemon/git tests; ends with ALL TESTS PASSED
npm run install:global    # install this checkout globally as a COPY
```

To work on this tool with an agent in its own sandbox, install it as a copy (`npm run install:global`), not with
`npm install -g .`. A linked install would let the sandboxed agent edit the code your PC runs. With a copy, the
agent's changes only reach your PC when you review them and install again.

## Inside the sandbox

Project scripts can check `AGENT_SANDBOX=1` to know they run in the sandbox, and `AGENT_SANDBOX_WORKSPACE` for the
project's path there (for example to skip installers or GPU checks).

## Releases

Releases are automatic. Bump `version` in `package.json` and push to master, and CI tags `v<version>` and publishes
a GitHub Release with:

- `windows-development-sandbox-<version>.tgz`
- `windows-development-sandbox.tgz` (the stable "latest" name)
- `install.ps1`

CI also publishes to GitHub Packages and to [npm](https://www.npmjs.com/package/windows-development-sandbox).
`npm run release:patch` bumps, tags and pushes in one go.

### npm

npm only lets CI publish a package that already exists, so the first version is published once from your PC:

```powershell
npm login
npm run publish:npm      # tests, packs like CI and publishes; asks for your 2FA code if you use one
```

Then, on npmjs.com, open the package's **Settings > Trusted Publisher**, choose GitHub Actions and enter the repository
and `release.yml`. From then on every release reaches npm with no token. An `NPM_TOKEN` secret works instead.
Until the first publish, CI skips npm with a warning.

The code layout and the rules for contributors (and agents) are in [CLAUDE.md](../CLAUDE.md).
