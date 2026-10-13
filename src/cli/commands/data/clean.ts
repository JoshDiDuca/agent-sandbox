// `sandbox data clean`: turns the targets you name into folders inside the data folder, and removes them.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { humanBytes, sizeOf } from '../../../core/disk.js';
import { askTyped, askYesNo } from '../../../core/prompt.js';
import { assertNoLinks, fail, isInsideOrEqual, isLink } from '../../../core/util/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { table } from '../../output/index.js';
import { type Context } from '../context.js';
import { removeTree } from './remove.js';

export interface CleanTarget {
  /** The target as normalised (forward slashes), e.g. "tools/go". */
  target: string;
  path: string;
  /** Folder the target must stay inside, with no links between the two. */
  root: string;
  warning?: string;
}

const DATA_AREAS = ['tools', 'databases', 'state', 'logs'] as const;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ +@-]*$/;
const LOGIN_WARNING =
  'removes the agent logins, settings and history inside the sandbox (save a Claude login first with: sandbox account save <name>)';
const ALL_WARNING =
  'removes EVERYTHING the sandbox keeps: toolchains, databases, agent logins and history, logs and launch folders';

/**
 * Turns `sandbox data clean` arguments into folders. Pure (no disk access); throws a UserError for anything that is
 * not a plain relative target inside the data folder: absolute paths, drive letters, `..`, wildcards, unknown areas.
 */
export function resolveCleanTargets(inputs: string[], dataPath: string, storageRoot: string): CleanTarget[] {
  const usage =
    'Targets: all | tools | tools/<name> | tools/agents/<name> | databases | databases/<name> | state | state/<agent> | logs | launches | views. See them with: sandbox data';
  if (!inputs.length) fail('Say what to remove.', usage);
  const resolved = inputs.map((raw): CleanTarget => {
    const input = raw.trim();
    if (!input) fail('Empty target.', usage);
    if (path.win32.isAbsolute(input) || path.posix.isAbsolute(input) || /^[A-Za-z]:/.test(input) || input.includes(':'))
      fail('Refusing "' + raw + '": targets are relative to the data folder, not paths on this PC.', usage);
    const parts = input.replace(/\\/g, '/').split('/').filter(Boolean);
    const bad = parts.find((p) => !SEGMENT.test(p) || /^\.+$/.test(p) || /[. ]$/.test(p));
    if (bad !== undefined)
      fail(
        'Refusing "' + raw + '": "' + bad + '" is not a plain folder name (no .., wildcards or special characters).',
        usage,
      );
    const [head, ...rest] = parts;
    const area = head.toLowerCase();
    if (parts.length > 3) fail('Refusing "' + raw + '": too deep.', usage);
    const target = [area, ...rest].join('/');
    if (area === 'all' && !rest.length)
      return { target: 'all', path: dataPath, root: path.join(storageRoot, 'data'), warning: ALL_WARNING };
    if (area === 'launches') return { target, path: path.join(storageRoot, 'launches', ...rest), root: storageRoot };
    if (area === 'views') {
      if (rest.length) fail('Remove all views ("views"), not single ones.', usage);
      return {
        target,
        path: path.join(storageRoot, 'views'),
        root: storageRoot,
        warning:
          'Views are the copies of your projects without their git-ignored files (workspaceFilter). Your projects are not touched; what the sandbox built or installed in them (node_modules, build output) goes, and the next start copies the projects again.',
      };
    }
    if (area === 'accounts' || area === 'sync')
      fail(
        '"' + area + '" is kept on this PC on purpose and is not removed here.',
        area === 'accounts' ? 'Remove a saved login with: sandbox account remove <name>' : usage,
      );
    if (!(DATA_AREAS as readonly string[]).includes(area)) fail('Unknown target "' + raw + '".', usage);
    if (area === 'logs' && rest.length) fail('Remove all logs ("logs"), not single files.', usage);
    if (rest.length > (area === 'tools' && rest[0]?.toLowerCase() === 'agents' ? 2 : 1))
      fail('Refusing "' + raw + '": too deep.', usage);
    return {
      target,
      path: path.join(dataPath, area, ...rest),
      root: dataPath,
      ...(area === 'state' ? { warning: LOGIN_WARNING } : {}),
    };
  });
  // "all" covers everything; otherwise drop targets inside another target (tools + tools/go = tools).
  const all = resolved.find((t) => t.target === 'all');
  if (all) return [all, { target: 'launches', path: path.join(storageRoot, 'launches'), root: storageRoot }];
  const unique = _.uniqBy(resolved, (t) => t.path.toLowerCase());
  return unique.filter((t) => !unique.some((o) => o !== t && isInsideOrEqual(o.path, t.path)));
}

export async function dataClean(ctx: Context): Promise<number> {
  const targets = resolveCleanTargets(ctx.options.positionals.slice(1), ctx.dataPath, ctx.storageRoot);
  if (isSandboxRunning())
    fail(
      'A Windows Sandbox is running, and it uses these folders.',
      'Close it first (sandbox stop), then run this again.',
    );
  // Every folder from the root down to the target's parent must be real; a link in place of the target is removed
  // itself.
  for (const t of targets) assertNoLinks(t.root, path.dirname(t.path));
  const present = targets.filter((t) => fs.existsSync(t.path) || isLink(t.path));
  if (!present.length) {
    console.log('Nothing to remove: ' + targets.map((t) => t.target).join(', ') + ' do(es) not exist.');
    return 0;
  }
  const sized = present.map((t) => ({ ...t, bytes: sizeOf(t.path) }));
  const total = _.sumBy(sized, 'bytes');
  table(sized.map((t) => ['  ' + t.target, humanBytes(t.bytes), t.path]));
  for (const t of sized) if (t.warning) console.log('Warning: ' + t.target + ' ' + t.warning + '.');
  const yes = Boolean((ctx.options as { yes?: boolean }).yes);
  if (!yes) {
    const ok = sized.some((t) => t.target === 'all')
      ? await askTyped('This cannot be undone; the next sandbox starts from scratch and reinstalls everything.', 'all')
      : await askYesNo(
          'Delete ' + sized.map((t) => t.target).join(', ') + ' (' + humanBytes(total) + ')? This cannot be undone.',
        );
    if (!ok) {
      console.log('Nothing removed.' + (process.stdin.isTTY ? '' : ' Pass --yes to confirm without a prompt.'));
      return 1;
    }
  }
  const failed: string[] = [];
  for (const t of sized) {
    try {
      removeTree(t.path, t.root);
    } catch (e) {
      failed.push(t.target + ' (' + (e instanceof Error ? e.message : String(e)) + ')');
    }
  }
  const freed = total - _.sumBy(sized, (t) => sizeOf(t.path));
  console.log(
    'Freed ' +
      humanBytes(freed) +
      '. ' +
      (sized.some((t) => t.root === ctx.dataPath || t.target === 'all')
        ? 'The next sandbox reinstalls what it needs.'
        : ''),
  );
  if (failed.length)
    fail(
      'Could not remove everything: ' + failed.join('; '),
      'Close programs using those folders and run the same command again.',
    );
  return 0;
}
