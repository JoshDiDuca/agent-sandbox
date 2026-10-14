// Turns `sandbox data clean` arguments into folders inside the data folder. Pure: no disk access.
import path from 'node:path';
import _ from 'lodash';
import { fail, isInsideOrEqual } from '../../core/util/index.js';

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
