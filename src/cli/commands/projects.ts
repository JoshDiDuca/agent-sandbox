// `sandbox projects`: which projects a sandbox can open without a restart. Project roots (whole folders of projects),
// the projects this tool has started before, and projects.all / projects.exclude. Changes to what is mapped take
// effect at the next start; a project you start while a sandbox runs joins it when it can (projects.ts in host/).
import path from 'node:path';
import { checkbox } from '@inquirer/prompts';
import { assertSafeMapping, assertSafeWorkspace } from '../../core/safe-paths.js';
import { dirExists, expandPath, fail, isRootPath } from '../../core/util/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import { forgetProject, readKnown, rememberProject } from '../../host/projects/index.js';
import { projectMapper } from '../../host/projects/index.js';
import { readRegistry } from '../../host/projects/index.js';
import { isWithin } from '../../shared/paths/index.js';
import { c, pageSizeFor, shortenMiddle, termWidth } from '../colors.js';
import { printJson, table, type Context } from './context.js';
import { hereDir } from './project.js';
import { addToList, removeFromList, setSetting } from './user-config.js';

interface Row {
  folder: string;
  here: boolean;
  known: boolean;
  root: string | null;
  excluded: boolean;
  mappedAtStart: boolean;
  running: string | null;
}

const settings = (ctx: Context) => {
  const p = ctx.loaded.config.projects;
  const expand = (list: string[]): string[] => list.map((x) => expandPath(x, ctx.loaded.base));
  return { all: p.all, roots: expand(p.roots), exclude: expand(p.exclude) };
};

/** Every project worth listing: known ones, the running sandbox's, and this folder. */
export const projectRows = (ctx: Context): Row[] => {
  const s = settings(ctx);
  const registry = isSandboxRunning() ? readRegistry(ctx.storageRoot) : null;
  const here = hereDir(ctx);
  const folders = [...readKnown(ctx.storageRoot).map((k) => k.host), ...(registry?.projects.map((p) => p.host) ?? [])];
  const unique = folders.filter((f, i) => folders.findIndex((g) => g.toLowerCase() === f.toLowerCase()) === i);
  return unique.map((folder) => {
    const root = s.roots.find((r) => isWithin(r, folder)) ?? null;
    const excluded = s.exclude.some((e) => isWithin(e, folder));
    const inSandbox = registry?.projects.find((p) => p.host.toLowerCase() === folder.toLowerCase());
    return {
      folder,
      here: isWithin(folder, here),
      known: readKnown(ctx.storageRoot).some((k) => k.host.toLowerCase() === folder.toLowerCase()),
      root,
      excluded,
      mappedAtStart: root !== null || (s.all && !excluded && dirExists(folder)),
      running: inSandbox ? inSandbox.name + ' (' + inSandbox.mechanism + ')' : null,
    };
  });
};

const NEXT_START = 'This changes what is mapped from the next start.';
const runningNote = (): string =>
  isSandboxRunning()
    ? ' The running sandbox keeps what it has; start a project in it (sandbox claude there) and it joins without a restart when it can, or you are offered one.'
    : '';

/** A folder for roots: it holds projects, so it must pass the same checks as a workspace and must not be a drive. */
const checkFolder = (ctx: Context, folder: string, what: string): string => {
  const dir = path.resolve(folder);
  if (!dirExists(dir)) fail('The folder ' + dir + ' does not exist.', 'Check the path.');
  if (isRootPath(dir))
    fail('A whole drive cannot be ' + what + ': ' + dir, 'Use the folder that holds your projects, e.g. F:\\Code.');
  assertSafeWorkspace(dir, ctx.packageRoot, ctx.storageRoot);
  assertSafeMapping(dir, ctx.packageRoot, ctx.storageRoot);
  return dir;
};

const list = (ctx: Context): number => {
  const rows = projectRows(ctx);
  const s = settings(ctx);
  if (printJson(ctx, { all: s.all, roots: s.roots, exclude: s.exclude, projects: rows })) return 0;
  console.log(
    c.bold('projects.all') +
      ': ' +
      (s.all ? 'on (every project below is mapped at every start, except excluded ones)' : 'off') +
      c.dim('   sandbox projects all on|off'),
  );
  console.log(
    c.bold('Roots') +
      ': ' +
      (s.roots.length ? s.roots.join(', ') : c.dim('none (sandbox projects roots add <folder>)')),
  );
  if (!rows.length) {
    console.log('No projects yet: start one with sandbox claude in its folder.');
    return 0;
  }
  const width = Math.max(20, termWidth() - 46);
  table([
    ['', 'FOLDER', 'AT START', 'RUNNING SANDBOX'],
    ...rows.map((r) => [
      r.here ? '*' : '',
      shortenMiddle(r.folder, width),
      r.root ? 'root' : r.excluded ? 'excluded' : r.mappedAtStart ? 'mapped' : '-',
      r.running ?? '-',
    ]),
  ]);
  console.log(c.dim('* = this folder.  Choose with: sandbox projects choose'));
  return 0;
};

/** Ticks the projects mapped at every start (turns projects.all on when any is ticked); the rest are excluded. */
const choose = async (ctx: Context): Promise<number> => {
  const rows = projectRows(ctx).filter((r) => !r.root);
  if (!rows.length) {
    console.log(
      'No projects to choose from yet (projects in a root are always mapped with it). Start one with sandbox claude in its folder.',
    );
    return 0;
  }
  if (!process.stdin.isTTY)
    fail(
      'sandbox projects choose needs an interactive terminal.',
      'Use sandbox projects include|exclude <folder> instead.',
    );
  const s = settings(ctx);
  const picked = await checkbox({
    message:
      'Projects mapped at every start, so they open without a restart (every agent in the sandbox can see them):',
    pageSize: pageSizeFor(rows.length),
    choices: rows.map((r) => ({
      value: r.folder,
      name: shortenMiddle(r.folder, termWidth() - 12) + (r.here ? c.dim('  (this folder)') : ''),
      checked: s.all && !r.excluded,
    })),
  });
  const exclude = rows.filter((r) => !picked.includes(r.folder)).map((r) => r.folder);
  setSetting(
    ctx,
    ['projects', 'exclude'],
    [...s.exclude.filter((e) => !rows.some((r) => r.folder.toLowerCase() === e.toLowerCase())), ...exclude],
  );
  setSetting(ctx, ['projects', 'all'], picked.length > 0);
  console.log(
    picked.length + ' project(s) mapped at every start, ' + exclude.length + ' excluded. ' + NEXT_START + runningNote(),
  );
  return 0;
};

export const projects = async (ctx: Context): Promise<number> => {
  const [action = 'list', value, folder] = ctx.options.positionals;
  switch (action) {
    case 'list':
      return list(ctx);
    case 'choose':
      return choose(ctx);
    case 'add': {
      const dir = checkFolder(ctx, value, 'a project');
      rememberProject(ctx.storageRoot, dir);
      console.log(
        'Added ' +
          dir +
          ' to your projects.' +
          (settings(ctx).all
            ? ' ' + NEXT_START
            : ' It is mapped at every start once projects.all is on (sandbox projects all on).'),
      );
      return 0;
    }
    case 'remove': {
      const dir = path.resolve(value);
      const forgot = forgetProject(ctx.storageRoot, dir);
      // The running sandbox forgets it too (its folder stays visible until the sandbox stops, if it was mapped).
      const registered = isSandboxRunning()
        ? readRegistry(ctx.storageRoot)?.projects.find((p) => !p.primary && p.host.toLowerCase() === dir.toLowerCase())
        : undefined;
      if (registered)
        projectMapper({ storageRoot: ctx.storageRoot, packageRoot: ctx.packageRoot, wsbShare: false }).unregister(
          registered.name,
        );
      console.log(
        forgot || registered
          ? 'Removed ' + dir + ' from your projects (nothing in the folder was touched).'
          : dir + ' was not in your projects.',
      );
      return 0;
    }
    case 'include':
    case 'exclude': {
      const dir = path.resolve(value);
      const changed =
        action === 'exclude'
          ? addToList(ctx, ['projects', 'exclude'], dir)
          : removeFromList(ctx, ['projects', 'exclude'], dir);
      if (action === 'include') rememberProject(ctx.storageRoot, dir);
      console.log(
        (changed ? (action === 'exclude' ? 'Excluded ' : 'Included ') + dir + '. ' + NEXT_START : 'Nothing changed.') +
          (action === 'include' && !settings(ctx).all
            ? ' projects.all is off: sandbox projects all on maps your projects at every start.'
            : '') +
          (changed ? runningNote() : ''),
      );
      return 0;
    }
    case 'all': {
      if (value === undefined) {
        console.log('projects.all is ' + (settings(ctx).all ? 'on' : 'off') + '.');
        return 0;
      }
      setSetting(ctx, ['projects', 'all'], value === 'on');
      console.log(
        'projects.all is ' +
          value +
          '. ' +
          NEXT_START +
          (value === 'on' ? ' Every agent in the sandbox can then see all of those projects.' : '') +
          runningNote(),
      );
      return 0;
    }
    case 'roots': {
      if (!value || value === 'list') {
        const roots = settings(ctx).roots;
        console.log(roots.length ? roots.join('\n') : 'No project roots. Add one: sandbox projects roots add <folder>');
        return 0;
      }
      if (value === 'add') {
        const dir = checkFolder(ctx, folder, 'a project root');
        const added = addToList(ctx, ['projects', 'roots'], dir);
        console.log(
          added
            ? 'Added the project root ' +
                dir +
                ': every project in it (also new ones) opens without a restart. Every agent in the sandbox can see all of them. ' +
                NEXT_START +
                runningNote()
            : dir + ' is a root already.',
        );
        return 0;
      }
      const dir = path.resolve(folder);
      console.log(
        removeFromList(ctx, ['projects', 'roots'], dir)
          ? 'Removed the project root ' + dir + '. ' + NEXT_START
          : dir + ' was not a root.',
      );
      return 0;
    }
    default:
      return fail('Unknown projects action "' + action + '".');
  }
};
