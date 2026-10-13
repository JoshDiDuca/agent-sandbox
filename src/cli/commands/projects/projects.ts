// `sandbox projects`: which projects a sandbox can open without a restart. Project roots (whole folders of projects),
// the projects this tool has started before, and projects.all / projects.exclude. Changes to what is mapped take
// effect at the next start; a project you start while a sandbox runs joins it when it can (projects.ts in host/).
import path from 'node:path';
import { checkbox } from '@inquirer/prompts';
import { fail } from '../../../core/util/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { c, pageSizeFor, shortenMiddle, termWidth, printJson, table } from '../../output/index.js';
import { ProjectsService } from '../../services/index.js';
import { type Context } from '../context.js';

const NEXT_START = 'This changes what is mapped from the next start.';
function runningNote(): string {
  return isSandboxRunning()
    ? ' The running sandbox keeps what it has; start a project in it (sandbox claude there) and it joins without a restart when it can, or you are offered one.'
    : '';
}

function list(ctx: Context, service: ProjectsService): number {
  const listing = service.list();
  const rows = listing.projects;
  if (printJson(ctx, { all: listing.all, roots: listing.roots, exclude: listing.exclude, projects: rows })) return 0;
  console.log(
    c.bold('projects.all') +
      ': ' +
      (listing.all ? 'on (every project below is mapped at every start, except excluded ones)' : 'off') +
      c.dim('   sandbox projects all on|off'),
  );
  console.log(
    c.bold('Roots') +
      ': ' +
      (listing.roots.length ? listing.roots.join(', ') : c.dim('none (sandbox projects roots add <folder>)')),
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
}

/** Ticks the projects mapped at every start (turns projects.all on when any is ticked); the rest are excluded. */
async function choose(service: ProjectsService): Promise<number> {
  const rows = service.rows().filter((r) => !r.root);
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
  const all = service.settings().all;
  const picked = await checkbox({
    message:
      'Projects mapped at every start, so they open without a restart (every agent in the sandbox can see them):',
    pageSize: pageSizeFor(rows.length),
    choices: rows.map((r) => ({
      value: r.folder,
      name: shortenMiddle(r.folder, termWidth() - 12) + (r.here ? c.dim('  (this folder)') : ''),
      checked: all && !r.excluded,
    })),
  });
  const { mapped, excluded } = service.choose(rows, picked);
  console.log(mapped + ' project(s) mapped at every start, ' + excluded + ' excluded. ' + NEXT_START + runningNote());
  return 0;
}

function add(service: ProjectsService, value: string): number {
  const dir = service.add(value);
  console.log(
    'Added ' +
      dir +
      ' to your projects.' +
      (service.settings().all
        ? ' ' + NEXT_START
        : ' It is mapped at every start once projects.all is on (sandbox projects all on).'),
  );
  return 0;
}

function remove(service: ProjectsService, value: string): number {
  const { dir, removed } = service.forget(value);
  console.log(
    removed
      ? 'Removed ' + dir + ' from your projects (nothing in the folder was touched).'
      : dir + ' was not in your projects.',
  );
  return 0;
}

function includeOrExclude(service: ProjectsService, action: 'include' | 'exclude', value: string): number {
  const changed = action === 'exclude' ? service.exclude(value) : service.include(value);
  console.log(
    (changed
      ? (action === 'exclude' ? 'Excluded ' : 'Included ') + path.resolve(value) + '. ' + NEXT_START
      : 'Nothing changed.') +
      (action === 'include' && !service.settings().all
        ? ' projects.all is off: sandbox projects all on maps your projects at every start.'
        : '') +
      (changed ? runningNote() : ''),
  );
  return 0;
}

function all(service: ProjectsService, value: string | undefined): number {
  if (value === undefined) {
    console.log('projects.all is ' + (service.settings().all ? 'on' : 'off') + '.');
    return 0;
  }
  service.setAll(value === 'on');
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

function roots(service: ProjectsService, value: string | undefined, folder: string): number {
  if (!value || value === 'list') {
    const list = service.settings().roots;
    console.log(list.length ? list.join('\n') : 'No project roots. Add one: sandbox projects roots add <folder>');
    return 0;
  }
  if (value === 'add') {
    const { dir, added } = service.addRoot(folder);
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
  const { dir, removed } = service.removeRoot(folder);
  console.log(removed ? 'Removed the project root ' + dir + '. ' + NEXT_START : dir + ' was not a root.');
  return 0;
}

export async function projects(ctx: Context): Promise<number> {
  const [action = 'list', value, folder] = ctx.options.positionals;
  const service = new ProjectsService(ctx);
  switch (action) {
    case 'list':
      return list(ctx, service);
    case 'choose':
      return choose(service);
    case 'add':
      return add(service, value);
    case 'remove':
      return remove(service, value);
    case 'include':
    case 'exclude':
      return includeOrExclude(service, action, value);
    case 'all':
      return all(service, value);
    case 'roots':
      return roots(service, value, folder);
    default:
      return fail('Unknown projects action "' + action + '".');
  }
}
