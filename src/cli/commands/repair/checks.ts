// The repair checks, in the order they run. Each either confirms all is well, fixes the problem itself, or says what
// you need to do. Nothing under the data folder is followed through a link.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import _ from 'lodash';
import { GB, freeBytesAt, humanBytes } from '../../../core/disk.js';
import { assertTestWritable } from '../../../shared/test-guard.js';
import { assertNoLinks, fileExists, isLink, isWin, removeLink } from '../../../core/util.js';
import { resetRunDir } from '../../../host/channel.js';
import { sandboxFeatureInstalled } from '../../../host/platform.js';
import { listSessions, runPaths, scanRequests } from '../../../shared/rundir.js';
import { removeTree } from '../data/remove.js';
import {
  deadPidFiles,
  findHalfInstalled,
  findLinks,
  findStagingLeftovers,
  globalPackages,
  resolvedVersionsValid,
} from './finders.js';
import { ok, whileRunning, type RepairCheck, type RepairEnv } from './types.js';

const rel = (root: string, p: string): string => path.relative(root, p) || '.';

/** Fails (throws) unless every folder from the data folder to `p` is real. */
const guard = (env: RepairEnv, p: string): void => assertNoLinks(path.dirname(env.dataPath), p);

export const CHECKS: RepairCheck[] = [
  {
    name: 'Config file',
    run: (env) =>
      env.configError
        ? {
            status: 'needs-you',
            detail:
              env.configError.message +
              (env.configError.fix ? ' ' + env.configError.fix : '') +
              ' (repair never rewrites your config; built-in defaults were used for the other checks.)',
          }
        : ok(
            env.ctx.loaded.configPath ? env.ctx.loaded.configPath + ' is valid.' : 'none; using the built-in defaults.',
          ),
  },
  {
    name: 'Windows Sandbox feature',
    run: () =>
      sandboxFeatureInstalled()
        ? ok('enabled.')
        : {
            status: 'needs-you',
            detail:
              (isWin ? 'Windows Sandbox is not turned on.' : 'This is not Windows.') +
              ' Run: sandbox setup (it checks this PC and offers to turn it on).',
          },
  },
  {
    name: 'Links in the data folder',
    run: (env) => {
      if (isLink(env.dataPath))
        return {
          status: 'needs-you',
          detail:
            env.dataPath +
            ' itself is a link or junction. agent-sandbox refuses to work through links; point storage.root at the real folder instead (sandbox config path).',
        };
      // A running sandbox can swap folders for links while we look; only check a stopped one.
      if (env.running) return whileRunning;
      const links = findLinks(env.dataPath);
      if (!links.length) return ok('none (nothing in ' + env.dataPath + ' points elsewhere).');
      // A link here can only have been made inside the sandbox; it could point at this PC's own files. Remove the link
      // itself, and only if every folder above it is still real.
      for (const link of links) {
        guard(env, path.dirname(link));
        removeLink(link);
      }
      return {
        status: 'fixed',
        detail:
          'removed ' +
          links.length +
          ' link(s)/junction(s) the sandbox created, without following them: ' +
          links.map((l) => rel(env.dataPath, l)).join(', '),
      };
    },
  },
  {
    name: 'Sandbox run state',
    run: (env) => {
      if (env.running) return ok('a sandbox is running; its state is in use.');
      if (isLink(runPaths(env.dataPath).run)) {
        resetRunDir(env.dataPath);
        return { status: 'fixed', detail: 'the run folder was a link; removed the link itself.' };
      }
      // The last sandbox's status file is normal after it closes; sessions still marked running or unanswered requests are not.
      const ghosts = listSessions(env.dataPath).filter((s) => s.phase === 'running' || s.phase === 'starting').length;
      const requests = scanRequests(env.dataPath);
      const pending = requests.valid.length + requests.invalid.length;
      if (!ghosts && !pending) return ok('clean.');
      resetRunDir(env.dataPath);
      return {
        status: 'fixed',
        detail:
          'no sandbox is running, but ' +
          _.compact([
            ghosts && ghosts + ' session(s) were still marked running',
            pending && pending + ' request(s) were never answered',
          ]).join(' and ') +
          '; cleared the run state so status/attach do not show ghosts.',
      };
    },
  },
  {
    name: 'Hidden-window state',
    run: (env) => {
      const file = path.join(env.storageRoot, 'run', 'hidden-windows.json');
      if (!fs.existsSync(file) && !isLink(file)) return ok('clean.');
      if (env.running) return ok('a sandbox is running; kept.');
      assertTestWritable(file);
      fs.rmSync(file, { force: true });
      return {
        status: 'fixed',
        detail: 'removed the saved hidden-window list from a sandbox that is no longer running.',
      };
    },
  },
  {
    name: 'Sync watcher',
    run: (env) => {
      const dead = deadPidFiles(path.join(env.storageRoot, 'run'));
      if (!dead.length) return ok('no stale watcher records.');
      for (const f of dead) {
        assertTestWritable(f);
        fs.rmSync(f, { force: true });
      }
      return {
        status: 'fixed',
        detail:
          'removed ' +
          dead.length +
          ' record(s) of a history sync watcher that is no longer running (the next launch starts a new one).',
      };
    },
  },
  {
    name: 'Interrupted downloads',
    run: (env) => {
      if (env.running) return whileRunning;
      guard(env, env.toolsDir);
      const found = findStagingLeftovers(env.toolsDir);
      if (!found.length) return ok('none.');
      for (const p of found) removeTree(p, env.dataPath);
      return {
        status: 'fixed',
        detail:
          'removed ' +
          found.length +
          ' half-finished download/copy folder(s): ' +
          found.map((p) => rel(env.toolsDir, p)).join(', '),
      };
    },
  },
  {
    name: 'Half-installed toolchains',
    run: (env) => {
      if (env.running) return whileRunning;
      guard(env, env.toolsDir);
      const found = findHalfInstalled(env.toolsDir);
      if (!found.length) return ok('every toolchain folder has its program.');
      for (const f of found) removeTree(f.path, env.dataPath);
      return {
        status: 'fixed',
        detail:
          'removed ' +
          found.map((f) => rel(env.toolsDir, f.path) + ' (no ' + f.missing + ')').join(', ') +
          '; the next sandbox reinstalls them.',
      };
    },
  },
  {
    name: 'Resolved versions cache',
    run: (env) => {
      const file = path.join(env.toolsDir, 'resolved-versions.json');
      if (!fs.existsSync(file) && !isLink(file)) return ok('not created yet.');
      if (env.running) return whileRunning;
      guard(env, env.toolsDir);
      if (isLink(file)) {
        removeLink(file);
        return { status: 'fixed', detail: 'removed a link in place of tools\\resolved-versions.json.' };
      }
      if (fs.statSync(file).size < 4 * 1024 * 1024 && resolvedVersionsValid(fs.readFileSync(file, 'utf8')))
        return ok('valid.');
      assertTestWritable(file);
      fs.rmSync(file, { force: true });
      return {
        status: 'fixed',
        detail:
          'tools\\resolved-versions.json was damaged; removed it (versions are looked up again on the next start).',
      };
    },
  },
  {
    name: 'Installed packages',
    run: () => {
      const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!fileExists(npmCli))
        return { status: 'skipped', detail: 'npm not found next to this Node (' + npmCli + ').' };
      // cwd = Node's own folder: npm reads .npmrc from the current folder, which could be a sandbox-writable workspace.
      const result = spawnSync(process.execPath, [npmCli, 'ls', '-g', '--json', '--depth=0'], {
        cwd: path.dirname(process.execPath),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const names = globalPackages(result.stdout ?? '');
      if (!names.length) return { status: 'skipped', detail: 'could not read the global npm packages.' };
      if (names.includes('agent-sandbox') && names.includes('windows-development-sandbox'))
        return {
          status: 'needs-you',
          detail:
            'the old agent-sandbox package is still installed next to windows-development-sandbox, and their commands clash. Run: npm uninstall -g agent-sandbox',
        };
      return ok(
        names.includes('agent-sandbox')
          ? 'agent-sandbox installed (the old name; fine on its own).'
          : 'no old agent-sandbox package.',
      );
    },
  },
  {
    name: 'Free disk',
    run: (env) => {
      const free = freeBytesAt(env.storageRoot);
      if (free === null) return { status: 'skipped', detail: 'could not check the drive of ' + env.storageRoot };
      if (free >= 20 * GB) return ok(humanBytes(free) + ' free.');
      return {
        status: 'warn',
        detail:
          humanBytes(free) +
          ' free on the drive of ' +
          env.storageRoot +
          (free < 5 * GB ? ': toolchains need several GB.' : ': getting low.') +
          ' See what is stored with: sandbox data, and free space with: sandbox data clean <target>',
      };
    },
  },
];
