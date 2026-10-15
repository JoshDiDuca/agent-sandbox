// Install: how this program was installed, and whether the pieces a managed install runs from are in one piece (the
// version and Node pointers, the shims, the PATH entry, the update task, the record). Fixes move a pointer, rewrite
// shims or add the user PATH entry; they never delete a version.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileExists } from '../../../../core/util/index.js';
import { editUserPath } from '../../../../host/agent-commands/index.js';
import {
  HIGH_INTEGRITY_SID,
  binsOfPackage,
  inspectPointers,
  pathHas,
  repairPointers,
  shimProblems,
} from '../../../../host/health/index.js';
import { UpdateTask, writeShims } from '../../../../host/install/index.js';
import { assertTestWritable, refuseInSelfTest } from '../../../../host/test-guard.js';
import { globalPackages } from '../finders.js';
import type { Check, Finding, FixOutcome, RepairEnv } from '../types.js';
import { ok, plural } from './common.js';

const UNINSTALL =
  '& ([scriptblock]::Create((irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1))) -Uninstall -Scope ';

const managed = (env: RepairEnv): boolean => env.layout !== null;
const machine = (env: RepairEnv): boolean => env.layout?.scope === 'machine';

/** The commands of the version the pointers name, else of the one running now. */
function currentBins(env: RepairEnv): Record<string, string> | null {
  const layout = env.layout;
  if (!layout) return null;
  const active = layout.activeVersion();
  return (active ? binsOfPackage(layout.packageDir(active)) : null) ?? binsOfPackage(env.ctx.packageRoot);
}

export const INSTALL_CHECKS: Check[] = [
  {
    id: 'install-kind',
    group: 'Install',
    name: 'Install type',
    run: (env: RepairEnv): Finding => {
      const layout = env.layout;
      if (!layout) return ok('npm global install (update it with npm; there are no automatic updates)');
      const who = layout.scope === 'machine' ? 'for everyone on this PC' : 'for you';
      return ok('managed install ' + who + ' in ' + layout.root + ', version ' + (layout.activeVersion() ?? 'unknown'));
    },
  },
  {
    id: 'install-record',
    group: 'Install',
    name: 'Install record',
    applies: managed,
    run: (env: RepairEnv): Finding => {
      if (env.record)
        return ok(
          'install.json: ' + env.record.scope + ' install, automatic updates ' + (env.record.autoUpdate ? 'on' : 'off'),
        );
      return {
        status: 'warn',
        detail: 'install.json is missing or cannot be read',
        means: 'Updates and sharing cannot tell how this was installed, so they act as if automatic updates are off.',
        fix: 'Run the installer again over this install (it writes the record and keeps your data).',
      };
    },
  },
  {
    id: 'install-pointers',
    group: 'Install',
    name: 'Active version',
    applies: managed,
    run: (env: RepairEnv): Finding => {
      const layout = env.layout;
      if (!layout) return ok('');
      const state = inspectPointers(layout);
      if (!state.problems.length) return ok('version ' + state.activeVersion + ' with Node ' + state.activeNode);
      const base = {
        status: 'needs-you' as const,
        detail: state.problems.join('; '),
        means: 'The sandbox command cannot start until both pointers name an installed version and Node.',
      };
      if (!state.want)
        return {
          ...base,
          fix: 'Nothing complete is installed in ' + layout.root + '. Run the installer again.',
        };
      return {
        ...base,
        plan:
          'point active-version at ' + state.want.version + ' and active-node at ' + state.want.node + ' (installed)',
      };
    },
    fix: (env: RepairEnv): FixOutcome => {
      if (!env.layout) throw new Error('not a managed install');
      assertTestWritable(env.layout.root);
      return { done: 'pointed at ' + repairPointers(env.layout) };
    },
  },
  {
    id: 'install-shims',
    group: 'Install',
    name: 'Commands (shims)',
    applies: managed,
    run: (env: RepairEnv): Finding => {
      const layout = env.layout;
      const bins = currentBins(env);
      if (!layout || !bins)
        return { status: 'skipped', detail: 'the package.json of the active version cannot be read' };
      const problems = shimProblems(layout, bins);
      const count = Object.keys(bins).length;
      if (!problems.missing.length && !problems.different.length)
        return ok(plural(count, 'command') + ' in ' + layout.binDir + ' read the active version');
      const bad = [
        ...problems.missing.map((f) => f + ' (missing)'),
        ...problems.different.map((f) => f + ' (out of date)'),
      ];
      return {
        status: 'needs-you',
        detail: bad.slice(0, 4).join(', ') + (bad.length > 4 ? ' and ' + (bad.length - 4) + ' more' : ''),
        means: 'Typing sandbox in a terminal may fail or run the wrong version.',
        plan: 'rewrite ' + plural(bad.length, 'command file') + ' in ' + layout.binDir,
        lines: bad,
      };
    },
    fix: (env: RepairEnv): FixOutcome => {
      const bins = currentBins(env);
      if (!env.layout || !bins) throw new Error('the package.json of the active version cannot be read');
      assertTestWritable(env.layout.binDir);
      writeShims(env.layout, bins);
      return { done: 'rewrote the command files for ' + Object.keys(bins).join(', ') };
    },
  },
  {
    id: 'install-path',
    group: 'Install',
    name: 'PATH',
    applies: managed,
    timeoutMs: 40_000,
    run: (env: RepairEnv): Finding => {
      const layout = env.layout;
      if (!layout) return ok('');
      const scope = layout.scope === 'machine' ? 'machine' : 'user';
      const where = scope === 'machine' ? 'the PATH of this PC' : 'your PATH';
      const own = env.system.registryPath(scope);
      if (own === null) return { status: 'skipped', detail: 'could not read ' + where };
      if (pathHas(own, layout.binDir)) return ok(layout.binDir + ' is on ' + where);
      const other = env.system.registryPath(scope === 'machine' ? 'user' : 'machine');
      const base = {
        status: 'needs-you' as const,
        detail:
          layout.binDir + ' is not on ' + where + (pathHas(other, layout.binDir) ? ' (only on the other one)' : ''),
        means: 'New terminals will not find the sandbox command.',
      };
      if (scope === 'user') return { ...base, plan: 'add ' + layout.binDir + ' to your PATH' };
      return {
        ...base,
        fix: 'Run the installer again in an admin PowerShell (it adds the folder to the PATH of this PC).',
      };
    },
    fix: (env: RepairEnv): FixOutcome => {
      if (!env.layout) throw new Error('not a managed install');
      editUserPath(env.layout.binDir, true, env.storageRoot);
      return { done: 'added ' + env.layout.binDir + ' to your PATH (open a new terminal to use it)' };
    },
  },
  {
    id: 'install-task',
    group: 'Install',
    name: 'Automatic updates',
    applies: machine,
    timeoutMs: 40_000,
    run: (env: RepairEnv): Finding => {
      const wanted = env.record?.autoUpdate ?? false;
      const has = env.system.updateTaskExists();
      if (has === null) return { status: 'skipped', detail: 'could not ask Windows about the update task' };
      if (has === wanted)
        return ok(wanted ? 'on, and the scheduled task is there' : 'off, and no scheduled task is left');
      const admin = env.system.tokenHasGroup(HIGH_INTEGRITY_SID) === true;
      const command = 'sandbox update --auto ' + (wanted ? 'on' : 'off');
      const base = {
        status: 'needs-you' as const,
        detail: wanted
          ? 'automatic updates are on but the scheduled task \\WindowsDevelopmentSandbox\\Update is missing'
          : 'automatic updates are off but the scheduled task is still there',
        means: wanted ? 'No update is installed by itself.' : 'The task keeps trying to update.',
      };
      return admin
        ? { ...base, plan: wanted ? 'create the update task' : 'remove the update task' }
        : { ...base, fix: 'Changing it needs admin rights. In an admin terminal run: ' + command };
    },
    fix: (env: RepairEnv): FixOutcome => {
      if (!env.layout) throw new Error('not a managed install');
      refuseInSelfTest('change scheduled tasks');
      const task = new UpdateTask(env.layout);
      if (env.record?.autoUpdate) {
        task.register();
        return { done: 'created the update task' };
      }
      task.remove();
      return { done: 'removed the update task' };
    },
  },
  {
    id: 'install-user-leftover',
    group: 'Install',
    name: 'Install for just you',
    applies: (env: RepairEnv): boolean => machine(env) && env.userInstallRoot !== null,
    run: (env: RepairEnv): Finding => {
      const root = env.userInstallRoot;
      if (!root || !fileExists(path.join(root, 'active-version')))
        return ok('no second install for just you next to this one');
      return {
        status: 'warn',
        detail: 'an install for just you is still in ' + root,
        means: 'Both are on your PATH; whichever comes first runs, and its updates differ from the one for everyone.',
        fix: 'Remove it in PowerShell (your data stays): ' + UNINSTALL + 'CurrentUser',
      };
    },
  },
  {
    id: 'install-old-npm',
    group: 'Install',
    name: 'npm packages',
    timeoutMs: 90_000,
    run: (env: RepairEnv): Finding => {
      const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!fileExists(npmCli)) return { status: 'skipped', detail: 'npm not found next to this Node (' + npmCli + ')' };
      // cwd = Node's own folder: npm reads .npmrc from the current folder, which could be a sandbox-writable workspace.
      const result = spawnSync(process.execPath, [npmCli, 'ls', '-g', '--json', '--depth=0'], {
        cwd: path.dirname(process.execPath),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const names = globalPackages(result.stdout ?? '');
      if (!names.length) return { status: 'skipped', detail: 'could not read the global npm packages' };
      if (names.includes('agent-sandbox') && names.includes('windows-development-sandbox'))
        return {
          status: 'needs-you',
          detail: 'the old agent-sandbox package is installed next to windows-development-sandbox',
          means: 'Their commands clash, and the one first on PATH runs.',
          fix: 'Run: npm uninstall -g agent-sandbox',
        };
      if (managed(env) && names.includes('windows-development-sandbox'))
        return {
          status: 'warn',
          detail: 'an npm global copy of windows-development-sandbox is installed next to the managed install',
          means: 'Both are on PATH; whichever comes first runs, and only the managed one updates itself.',
          fix: 'Run: npm uninstall -g windows-development-sandbox',
        };
      return ok(
        names.includes('agent-sandbox')
          ? 'agent-sandbox installed (the old name; fine on its own)'
          : 'no old agent-sandbox package',
      );
    },
  },
];
