// "Start several agents": projects, then agents for each, then where to attach. It only builds a command line
// (sandbox launch --session <agent>@<folder> ...), so "repeat last" works and typing it does the same.
import fs from 'node:fs';
import path from 'node:path';
import { assertSafeWorkspace } from '../../core/safe-paths.js';
import { errMsg, expandPath } from '../../core/util/index.js';
import { KnownProjects } from '../../host/projects/index.js';
import { isWithin } from '../../shared/paths/index.js';
import type { Context } from '../commands/context.js';
import { commandLine } from '../history.js';
import { Text, Theme, type App } from '../tui/index.js';
import { askPath } from './settings/ask-path.js';

/** Folders worth offering: this one, the projects started before, and the folders inside your roots. */
export function candidateFolders(ctx: Context, cwd: string = process.cwd()): string[] {
  const roots = ctx.loaded.config.projects.roots.map((r) => expandPath(r, ctx.loaded.base));
  const inRoots = roots.flatMap((r) => {
    try {
      return fs
        .readdirSync(r, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
        .slice(0, 200)
        .map((e) => path.join(r, e.name));
    } catch {
      return [];
    }
  });
  const all = [path.resolve(cwd), ...new KnownProjects(ctx.storageRoot).list().map((k) => k.host), ...inRoots];
  return all.filter((f, i) => all.findIndex((g) => g.toLowerCase() === f.toLowerCase()) === i && fs.existsSync(f));
}

/** The command line for several sessions: one --session per (agent, folder), with the shared options. */
export function severalAgentsArgv(
  sessions: { harness: string; folder: string }[],
  o: { headless: boolean; attachFirst: boolean },
): string[] {
  return [
    'launch',
    ...sessions.flatMap((s) => ['--session', s.harness + '@' + s.folder]),
    ...(o.headless ? ['--headless'] : []),
    ...(o.attachFirst ? ['-t'] : []),
  ];
}

const ADD = '@add';

export class SeveralAgents {
  private readonly path = ['Start several agents'];
  constructor(
    private readonly app: App,
    private readonly ctx: Context,
  ) {}

  async run(): Promise<string[] | null> {
    const folders = await this.folders();
    if (!folders?.length) return null;
    const agents = Object.keys(this.ctx.loaded.config.harnesses);
    const sessions: { harness: string; folder: string }[] = [];
    for (const folder of folders) {
      const picked = await this.app.list<string>({
        path: [...this.path, path.basename(folder)],
        intro: 'Agents for ' + folder + ' (one session each). Space ticks, Enter continues.',
        multi: true,
        items: agents.map((a) => ({ value: a, label: a, checked: a === this.ctx.loaded.config.defaultHarness })),
      });
      if (picked.kind !== 'multi') return null;
      sessions.push(...picked.values.map((harness) => ({ harness, folder })));
    }
    if (!sessions.length) return null;
    const headless = await this.app.confirm({
      path: this.path,
      question: 'Hide the sandbox window (headless)?',
      about: ['Sandbox > Show the window brings it back.'],
      initial: this.ctx.loaded.config.sandbox.headless,
    });
    const attach = await this.app.choose<number>(
      this.path,
      'Attach this terminal to one of them? Each session also has a tab inside the sandbox; Sessions shows any of them later.',
      [
        { value: -1, label: 'None' },
        ...sessions.map((s, i) => ({ value: i, label: s.harness + ' in ' + Text.middle(s.folder, 60) })),
      ],
      0,
    );
    if (attach === undefined) return null;
    // The one to attach goes first: -t attaches the first session.
    const ordered = attach >= 0 ? [sessions[attach], ...sessions.filter((_s, i) => i !== attach)] : sessions;
    const argv = severalAgentsArgv(ordered, { headless, attachFirst: attach >= 0 });
    const projects = [...new Set(sessions.map((s) => path.basename(s.folder)))];
    const go = await this.app.confirm({
      path: this.path,
      question: 'Start them?',
      about: [
        'One sandbox with ' +
          sessions.length +
          ' session' +
          (sessions.length === 1 ? '' : 's') +
          ': ' +
          ordered.map((s) => s.harness + ' in ' + path.basename(s.folder)).join(', ') +
          '. Maps ' +
          projects.join(' and ') +
          '.',
        '',
        '$ ' + commandLine(argv),
      ],
    });
    return go ? argv : null;
  }

  private async folders(): Promise<string[] | null> {
    const here = path.resolve(process.cwd());
    const candidates = candidateFolders(this.ctx);
    const picked = await this.app.list<string>({
      path: this.path,
      intro:
        'Which projects? Each gets its own sessions; all of them are mapped into one sandbox. Space ticks, Enter continues.',
      multi: true,
      items: [
        ...candidates.map((f) => ({
          value: f,
          label: Text.middle(f, 90),
          hint: isWithin(f, here) && isWithin(here, f) ? Theme.muted('this folder') : undefined,
          checked: f.toLowerCase() === here.toLowerCase(),
        })),
        { value: ADD, label: '+ Another folder…' },
      ],
    });
    if (picked.kind !== 'multi') return null;
    const folders = picked.values.filter((f) => f !== ADD);
    if (picked.values.includes(ADD)) {
      const extra = await askPath(this.app, {
        path: this.path,
        title: 'Choose the folder to add',
        kind: 'dir',
        validate: (v) => {
          const dir = path.resolve(v.trim());
          if (!v.trim() || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 'Not a folder: ' + dir;
          try {
            assertSafeWorkspace(dir, this.ctx.packageRoot, this.ctx.storageRoot);
            return true;
          } catch (e) {
            return errMsg(e);
          }
        },
      });
      if (extra) folders.push(path.resolve(extra));
    }
    return folders;
  }
}
