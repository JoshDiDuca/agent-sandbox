// The menu's "Start several agents": projects, then agents for each, then options; it only builds a command line
// (sandbox launch --session <agent>@<folder> ...), so "repeat last" works and typing it does the same.
import fs from 'node:fs';
import path from 'node:path';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { assertSafeWorkspace } from '../core/safe-paths.js';
import { expandPath, errMsg } from '../core/util.js';
import { readKnown } from '../host/projects.js';
import { isWithin } from '../shared/projects.js';
import type { Context } from './commands/context.js';
import { c, pageSizeFor, shortenMiddle, termWidth } from './colors.js';
import { commandLine } from './history.js';

const ADD = '@add';

/** Folders worth offering: this one, the projects started before, and the folders inside your roots. */
export const candidateFolders = (ctx: Context, cwd: string = process.cwd()): string[] => {
  const roots = ctx.loaded.config.projects.roots.map((r) => expandPath(r, ctx.loaded.base));
  const inRoots = roots.flatMap((r) => { try { return fs.readdirSync(r, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.')).slice(0, 200).map((e) => path.join(r, e.name)); } catch { return []; } });
  const all = [path.resolve(cwd), ...readKnown(ctx.storageRoot).map((k) => k.host), ...inRoots];
  return all.filter((f, i) => all.findIndex((g) => g.toLowerCase() === f.toLowerCase()) === i && fs.existsSync(f));
};

/** The command line for several sessions: one --session per (agent, folder), with the shared options. */
export const severalAgentsArgv = (sessions: { harness: string; folder: string }[], o: { headless: boolean; attachFirst: boolean }): string[] =>
  ['launch', ...sessions.flatMap((s) => ['--session', s.harness + '@' + s.folder]), ...(o.headless ? ['--headless'] : []), ...(o.attachFirst ? ['-t'] : [])];

export const askSeveralAgents = async (ctx: Context): Promise<string[] | null> => {
  const here = path.resolve(process.cwd());
  const width = Math.max(20, termWidth() - 14);
  let folders = await checkbox({
    message: 'Which projects? (each gets its sessions; all of them are mapped into one sandbox)',
    pageSize: pageSizeFor(16),
    choices: [
      ...candidateFolders(ctx).map((f) => ({ value: f, name: shortenMiddle(f, width) + (isWithin(f, here) && isWithin(here, f) ? c.dim('  (this folder)') : ''), checked: f.toLowerCase() === here.toLowerCase() })),
      { value: ADD, name: 'Add a folder...' },
    ],
  });
  if (folders.includes(ADD)) {
    const extra = await input({
      message: 'Folder to add:',
      validate: (v) => {
        const dir = path.resolve(v.trim());
        if (!v.trim() || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 'Not a folder: ' + dir;
        try { assertSafeWorkspace(dir, ctx.packageRoot, ctx.storageRoot); return true; } catch (e) { return errMsg(e); }
      },
    });
    folders = [...folders.filter((f) => f !== ADD), path.resolve(extra.trim())];
  }
  if (!folders.length) return null;
  const agents = Object.keys(ctx.loaded.config.harnesses);
  const sessions: { harness: string; folder: string }[] = [];
  for (const folder of folders) {
    const picked = await checkbox({
      message: 'Agents for ' + shortenMiddle(folder, width - 10) + ' (one session each):',
      pageSize: pageSizeFor(agents.length),
      choices: agents.map((a) => ({ value: a, name: a, checked: a === ctx.loaded.config.defaultHarness })),
      required: true,
    });
    sessions.push(...picked.map((harness) => ({ harness, folder })));
  }
  const headless = await confirm({ message: 'Hide the sandbox window (headless)?', default: ctx.loaded.config.sandbox.headless });
  const attach = await select({
    message: 'Attach this terminal to:',
    choices: [{ name: 'none (each has a tab inside; sandbox attach shows any of them)', value: -1 }, ...sessions.map((s, i) => ({ name: s.harness + ' in ' + shortenMiddle(s.folder, width - 20), value: i }))],
    default: 0,
  });
  // The one to attach goes first: -t attaches the first session.
  const ordered = attach >= 0 ? [sessions[attach], ...sessions.filter((_s, i) => i !== attach)] : sessions;
  const projects = [...new Set(sessions.map((s) => path.basename(s.folder)))];
  console.log('Start 1 sandbox with ' + sessions.length + ' session' + (sessions.length === 1 ? '' : 's') + ': ' + ordered.map((s) => s.harness + ' in ' + path.basename(s.folder)).join(', ') + ' - map ' + projects.join(' and '));
  const argv = severalAgentsArgv(ordered, { headless, attachFirst: attach >= 0 });
  console.log(c.dim('  ' + commandLine(argv)));
  return await confirm({ message: 'Start them?', default: true }) ? argv : null;
};
