// `sandbox repair`: finding half-installed toolchains, interrupted downloads, stale pid files and broken state.
import path from 'node:path';
import {
  deadPidFiles,
  findHalfInstalled,
  findStagingLeftovers,
  globalPackages,
  resolvedVersionsValid,
} from '../cli/commands/repair/finders.js';
import type { Suite } from './support/suite.js';

export const repairSuite: Suite = {
  name: 'repair',
  title: 'repair detection (half-installed tools, leftovers, stale pids)',
  run: (t) => {
    t.section('tools folder');
    const tools = t.at('repair', 'tools');
    t.write(path.join(tools, 'go', '1.23.2', 'bin', 'go.exe'), 'x');
    t.dir('repair', 'tools', 'go', '1.22.8', 'src');
    t.write(path.join(tools, 'java', 'jdk-21', 'bin', 'java.exe'), 'x');
    t.dir('repair', 'tools', 'java', 'jdk-17', 'lib');
    t.write(path.join(tools, 'python', 'python-3.12.7', 'python.exe'), 'x');
    t.write(path.join(tools, 'nvm', 'settings.txt'), 'x');
    t.write(path.join(tools, 'nvm', 'v22.11.0', 'node.exe'), 'x');
    t.dir('repair', 'tools', 'nvm', 'v20.18.0');
    t.write(path.join(tools, 'git', 'bin', 'bash.exe'), 'x');
    t.dir('repair', 'tools', 'dotnet', 'sdk');
    t.dir('repair', 'tools', 'go', '1.24.0.staging-ab12cd');
    t.dir('repair', 'tools', 'node-staging');
    t.dir('repair', 'tools', 'rust.staging-0f');

    const half = findHalfInstalled(tools)
      .map((h) => path.relative(tools, h.path))
      .sort();
    const expectedHalf = [
      path.join('go', '1.22.8'),
      path.join('java', 'jdk-17'),
      'dotnet',
      'nvm',
      path.join('nvm', 'v20.18.0'),
    ].sort();
    t.equal(half, expectedHalf, 'half-installed toolchains are folders without their program');
    const leftovers = findStagingLeftovers(tools)
      .map((p) => path.relative(tools, p))
      .sort();
    t.equal(
      leftovers,
      [path.join('go', '1.24.0.staging-ab12cd'), 'node-staging', 'rust.staging-0f'].sort(),
      'interrupted downloads are found in tools and one level down',
    );

    t.section('state files');
    t.check(
      resolvedVersionsValid('{"go":"1.23.2"}') && resolvedVersionsValid('﻿{}'),
      'resolved-versions.json: a JSON object is valid (a byte-order mark is fine)',
    );
    t.check(
      !resolvedVersionsValid('{"go":') && !resolvedVersionsValid('[1]'),
      'resolved-versions.json: broken JSON and non-objects are invalid',
    );
    t.equal(
      globalPackages('{"dependencies":{"agent-sandbox":{"version":"1.0.0"},"npm":{}}}'),
      ['agent-sandbox', 'npm'],
      '`npm ls -g --json` output is read',
    );
    t.equal(globalPackages('nope'), [], '`npm ls -g` output that is not JSON gives no packages');
    t.equal(globalPackages('{"dependencies":3}'), [], '`npm ls -g` output of the wrong shape gives no packages');

    const run = t.at('repair', 'run');
    t.write(path.join(run, 'watcher-default.pid'), '4242');
    t.write(path.join(run, 'watcher-other.pid'), String(process.pid));
    t.write(path.join(run, 'watcher-junk.pid'), 'not a pid');
    t.write(path.join(run, 'hidden-windows.json'), '[]');
    const dead = deadPidFiles(run, (pid) => pid === process.pid)
      .map((file) => path.basename(file))
      .sort();
    t.equal(
      dead,
      ['watcher-default.pid', 'watcher-junk.pid'],
      'stale watcher pid files (dead process or junk) are found; a live one is kept',
    );
  },
};
