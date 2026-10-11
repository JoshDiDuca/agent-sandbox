// `sandbox data` target resolution and `sandbox repair` detection (half-installed toolchains, leftovers, links).
import fs from 'node:fs';
import path from 'node:path';
import { resolveCleanTargets } from '../cli/commands/data/clean.js';
import { removeTree } from '../cli/commands/data/remove.js';
import { deadPidFiles, findHalfInstalled, findLinks, findStagingLeftovers, globalPackages, resolvedVersionsValid } from '../cli/commands/repair/finders.js';
import { humanBytes, sizeOf } from '../core/disk.js';
import { ensureDir, errMsg } from '../core/util.js';
import type { Harness } from './harness.js';

export const dataTests = (t: Harness): void => {
  const { check, write } = t;

  t.section('data: clean targets');
  const storage = path.join(t.temp, 'data-store');
  const dataPath = path.join(storage, 'data', 'default');
  const resolve = (...inputs: string[]): string[] => resolveCleanTargets(inputs, dataPath, storage).map((r) => path.relative(storage, r.path));
  const rejected = (...inputs: string[]): boolean => { try { resolveCleanTargets(inputs, dataPath, storage); return false; } catch (e) { return errMsg(e).length > 0; } };
  const d = (...parts: string[]): string => path.join('data', 'default', ...parts);
  check(resolve('tools/go').join() === d('tools', 'go') && resolve('tools\\go').join() === d('tools', 'go') && resolve('Tools/agents/claude').join() === d('tools', 'agents', 'claude'), 'clean: tools/<name> and tools/agents/<name> resolve inside the data folder (either slash)');
  check(resolve('databases/postgres-18').join() === d('databases', 'postgres-18') && resolve('logs').join() === d('logs') && resolve('launches').join() === 'launches' && resolve('state/claude').join() === d('state', 'claude'), 'clean: databases/<name>, logs, launches, state/<agent>');
  check(resolve('tools', 'tools/go', 'tools/go').join() === d('tools') && resolve('all', 'logs').join() === [d(), 'launches'].join(), 'clean: nested and repeated targets collapse; all = the data folder + launches');
  check(Boolean(resolveCleanTargets(['state/claude'], dataPath, storage)[0].warning?.includes('login')) && Boolean(resolveCleanTargets(['all'], dataPath, storage)[0].warning), 'clean: state and all carry a warning');
  const bad = ['', '..', 'tools/..', 'tools/../../x', '../data', 'C:\\Windows', 'C:tools', '/etc', '\\\\server\\share', 'tools/*', 'tools/go:stream', 'tools/a/b', 'tools/agents/a/b', 'logs/guest.log', 'accounts', 'sync', 'windows', 'tools/.', 'tools/go.'];
  const accepted = bad.filter((b) => !rejected(b));
  check(accepted.length === 0 && rejected(), 'clean: rejects .., absolute paths, drive letters, UNC, wildcards, streams, too deep, unknown areas, nothing (accepted: ' + JSON.stringify(accepted) + ')');

  t.section('data: sizes and removal never follow links');
  const sized = path.join(t.temp, 'sized');
  write(path.join(sized, 'a.bin'), 'x'.repeat(1000));
  write(path.join(sized, 'sub', 'b.bin'), 'y'.repeat(24));
  const outside = path.join(t.temp, 'outside');
  write(path.join(outside, 'keep.txt'), 'z'.repeat(5000));
  let linked = false;
  try { fs.symlinkSync(outside, path.join(sized, 'sub', 'escape'), 'junction'); linked = true; } catch { /* no junctions here */ }
  check(sizeOf(sized) === 1024 && humanBytes(1536) === '1.5 KB' && humanBytes(0) === '0 B' && humanBytes(3 * 1024 ** 3) === '3.0 GB', 'data: sizes count real files only' + (linked ? ' (a junction counts 0)' : ''));
  if (linked) check(findLinks(sized).length === 1, 'repair: finds a junction planted in the data folder');
  removeTree(sized, t.temp);
  check(!fs.existsSync(sized) && fs.existsSync(path.join(outside, 'keep.txt')), 'data: removing a folder never deletes what a link inside points to');

  t.section('repair: detection');
  const tools = path.join(t.temp, 'repair', 'tools');
  write(path.join(tools, 'go', '1.23.2', 'bin', 'go.exe'), 'x');
  ensureDir(path.join(tools, 'go', '1.22.8', 'src'));
  write(path.join(tools, 'java', 'jdk-21', 'bin', 'java.exe'), 'x');
  ensureDir(path.join(tools, 'java', 'jdk-17', 'lib'));
  write(path.join(tools, 'python', 'python-3.12.7', 'python.exe'), 'x');
  write(path.join(tools, 'nvm', 'settings.txt'), 'x');
  write(path.join(tools, 'nvm', 'v22.11.0', 'node.exe'), 'x');
  ensureDir(path.join(tools, 'nvm', 'v20.18.0'));
  write(path.join(tools, 'git', 'bin', 'bash.exe'), 'x');
  ensureDir(path.join(tools, 'dotnet', 'sdk'));
  ensureDir(path.join(tools, 'go', '1.24.0.staging-ab12cd'));
  ensureDir(path.join(tools, 'node-staging'));
  ensureDir(path.join(tools, 'rust.staging-0f'));
  const half = findHalfInstalled(tools).map((h) => path.relative(tools, h.path)).sort();
  check(half.join() === ['dotnet', 'java\\jdk-17', 'go\\1.22.8', 'nvm', 'nvm\\v20.18.0'].map((p) => p.split('\\').join(path.sep)).sort().join(), 'repair: half-installed toolchains = folder without its program (got ' + half.join(', ') + ')');
  const staging = findStagingLeftovers(tools).map((p) => path.relative(tools, p)).sort();
  check(staging.join() === [path.join('go', '1.24.0.staging-ab12cd'), 'node-staging', 'rust.staging-0f'].sort().join(), 'repair: interrupted downloads in tools and one level down (got ' + staging.join(', ') + ')');
  check(resolvedVersionsValid('{"go":"1.23.2"}') && resolvedVersionsValid('\uFEFF{}') && !resolvedVersionsValid('{"go":') && !resolvedVersionsValid('[1]'), 'repair: resolved-versions.json must be a JSON object');
  check(globalPackages('{"dependencies":{"agent-sandbox":{"version":"1.0.0"},"npm":{}}}').join() === 'agent-sandbox,npm' && globalPackages('nope').length === 0 && globalPackages('{"dependencies":3}').length === 0, 'repair: reads npm ls -g --json');
  const run = path.join(t.temp, 'repair', 'run');
  write(path.join(run, 'watcher-default.pid'), '4242');
  write(path.join(run, 'watcher-other.pid'), String(process.pid));
  write(path.join(run, 'watcher-junk.pid'), 'not a pid');
  write(path.join(run, 'hidden-windows.json'), '[]');
  const dead = deadPidFiles(run, (pid) => pid === process.pid).map((f) => path.basename(f)).sort();
  check(dead.join() === 'watcher-default.pid,watcher-junk.pid', 'repair: stale watcher pid files (dead process or junk) are found; a live one is kept');
};
