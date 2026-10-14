# Development

```powershell
npm install               # dependencies + build
npm test                  # offline, security and live ConPTY/daemon/git tests; ends with ALL TESTS PASSED
npm run install:global    # install this checkout globally as a COPY
npm run lint              # ESLint (typescript-eslint): the coding standard and the architecture boundaries
npm run format            # Prettier (120 columns); npm run format:check only checks
```

`npm run lint` and `npm run format:check` must pass before a pull request. ESLint also enforces the layers: guest code
never imports host, CLI or sync code, core and shared import neither, and only the CLI, `api.ts` and `bin/` sit on top.
C# (`sandbox/csharp`, `native/csharp`) is C# 5 and must compile with
`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`; `.ps1` and `.cmd` files are CRLF.

The self-test refuses to run on a normal PC: it only runs inside a Windows Sandbox (run `sandbox start`, then `npm test`
in it) or on GitHub Actions, because the live tests create files, links and processes. `sandbox self-test` is the same
thing. While it runs, `AGENT_SANDBOX_SELFTEST=1` makes host code refuse outward actions and any write or delete outside
the test's temp folder (`src/shared/test-guard.ts`, `src/host/test-guard.ts`); the `test-guard` suite checks that.

## Tests

`npm test` runs every suite and ends with `ALL TESTS PASSED` (or `N TEST(S) FAILED`). Run part of it:

```powershell
npm test -- config                                    # one suite (builds first)
node dist/bin/agent-sandbox.js self-test cli,sync     # several, without building
node dist/bin/agent-sandbox.js self-test nope         # prints the list of suite names
```

- One file per area in `src/selftest/`, named `<area>.test.ts`, exporting a `Suite` (`support/suite.ts`). `index.ts`
  lists the suites in run order. A suite that throws or hangs (default 2 minutes, `timeoutMs`) fails alone; the rest
  still run.
- `support/harness.ts`: `t.equal(actual, expected, name)` (failures show both), `t.includes`, `t.excludes`, `t.matches`,
  `t.throws(fn, 'text' | /regex/, name)` (message and fix hint), `t.check(ok, name, detail)`, `t.waitFor(read, ms)`,
  `t.touch(file)` (make a change clearly newer instead of sleeping), temp helpers `t.at`, `t.dir`, `t.write`,
  `t.writeJson`, `t.readJson`.
- `support/fixtures.ts`: a fake PC (Node, Claude Code, a profile, workspaces) with `f.makeConfig()`, `f.run()`,
  `f.launch()` (resolve + generate), `f.runGuest()` and `f.runBin()` (a built command as its own process).
- Live suites (`live-*.test.ts`, helpers in `support/live.ts`) start the real daemon, ptyhost and git shim, and
  compile SandboxTools and HostTools. They never sleep for a
  fixed time: they poll until the condition holds, with long deadlines, and print the viewer's screen and the daemon log
  when a check fails. Keep it that way; a flaky test is a bug in the test or the product.
- The `layout` suite checks the compiled imports: guest code reaches only the portable core, nothing imports an entry
  point, there are no import cycles, and the pure guest files host code and tests may load never pull in the guest
  runtime's side effects.
- Slowest suites: `host-sim` (every command as its own Node process, two at a time), then the live ones.

CI builds on Node 22 and on the official Node 22.0.0 zip (the oldest Node users run it on, so dependencies must not
need newer), and runs the self-test as information only. Releases and `npm run publish:npm` run no tests.

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
npm run publish:npm      # builds, packs like CI and publishes (no tests); asks for your 2FA code if you use one
```

Then add an npm automation token as the repository's `NPM_TOKEN` secret. From then on every release reaches npm. Without
the secret CI skips npm, and a failed npm publish is only a warning: the GitHub release still goes out. Until the first
publish, CI skips npm with a warning.

The code layout and the rules for contributors (and agents) are in [CLAUDE.md](../CLAUDE.md).
