// Turning the folder you run in into a sandbox run: guest path, tool versions from version files, folders that are refused.
import fs from 'node:fs';
import path from 'node:path';
import { voltaNode, autoGuestWorkspace } from '../core/workspace.js';
import type { Suite } from './suite.js';

export const workspaceSuite: Suite = {
  name: 'workspace',
  title: 'workspace resolution, version files (.nvmrc ...), refused folders',
  run: async (t, f) => {
    t.section('guest folder and defaults');
    const run = await f.run();
    t.equal(
      {
        host: run.workspaceHost,
        guest: run.config.guestWorkspace,
        harness: run.harnessName,
        dataFolder: path.basename(run.dataPath),
      },
      { host: f.workA, guest: 'C:\\Workspace\\work-a', harness: 'claude', dataFolder: 'testdata' },
      'any folder is the workspace; its guest path is C:\\Workspace\\<folder name>',
    );
    t.equal(
      autoGuestWorkspace('C:\\x\\My Proj (2)'),
      'C:\\Workspace\\My Proj _2_',
      'auto guest folder names are sanitised',
    );
    t.equal(
      autoGuestWorkspace('D:\\...'),
      'C:\\Workspace\\project',
      'a folder name with nothing usable becomes "project"',
    );
    t.equal(
      { node: run.versions.node.spec, nodeSource: run.versions.node.source, python: run.versions.python.spec },
      { node: '22.3.0', nodeSource: 'this PC', python: '3' },
      "the default Node version is this PC's; Python defaults to the latest 3.x",
    );

    t.section('version files');
    const nvmrc = path.join(f.workA, '.nvmrc');
    const pythonVersion = path.join(f.workA, '.python-version');
    t.write(nvmrc, 'lts/iron\n');
    t.write(pythonVersion, '3.11\n');
    const withFiles = await f.run();
    t.equal(
      {
        node: withFiles.versions.node.spec,
        source: withFiles.versions.node.source,
        python: withFiles.versions.python.spec,
      },
      { node: 'lts/iron', source: '.nvmrc', python: '3.11' },
      '.nvmrc and .python-version are respected',
    );
    t.equal((await f.run({ nodeVersion: '18' })).versions.node.source, 'command line', '--node beats .nvmrc');
    fs.rmSync(nvmrc);
    fs.rmSync(pythonVersion);
    const nodeVersion = path.join(f.workA, '.node-version');
    t.write(nodeVersion, 'v20.11.1');
    t.equal((await f.run()).versions.node.spec, 'v20.11.1', '.node-version is respected');
    fs.rmSync(nodeVersion);

    const voltaProject = t.write(
      t.at('volta-ws', 'package.json'),
      '{"name":"x","volta":{"node":"20.11.1","pnpm":"9.1.0"}}',
    );
    t.write(t.at('no-volta-ws', 'package.json'), '{"name":"y","volta":{"node":"latest; rm -rf"}}');
    t.equal(
      voltaNode(path.dirname(voltaProject)),
      '20.11.1',
      'Volta: package.json "volta.node" picks the Node version',
    );
    t.equal(voltaNode(t.at('no-volta-ws')), null, 'Volta: only a plain version is accepted');
    t.equal(voltaNode(t.at('missing')), null, 'Volta: a folder without package.json has no version');

    t.section('folders that are refused');
    await t.throws(() => f.run({ cwd: f.install }), 'install folder', 'the install folder is refused');
    await t.throws(
      () => f.run({ cwd: t.temp }),
      'must not be able to change',
      'a parent of the install folder is refused',
    );
    await t.throws(() => f.run({ cwd: t.at('storage') }), 'storage folder', 'the storage folder is refused');
    const originalWindir = process.env.WINDIR;
    const fakeWindows = t.dir('winroot');
    const systemFolder = t.dir('winroot', 'sys');
    process.env.WINDIR = fakeWindows;
    try {
      await t.throws(
        () => f.run({ cwd: systemFolder }),
        'system folder',
        'a folder inside the Windows folder is refused',
      );
    } finally {
      if (originalWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = originalWindir;
    }
    await t.throws(() => f.run({ cwd: path.parse(t.temp).root }), 'whole drive', 'a whole drive is refused');
  },
};
