// What the terminal says while a sandbox starts: the first-start heads-up (what is downloaded, roughly how much) and
// one line of progress from the guest's status. Pure: the status is guest-written, so every bit of it is made safe
// and short here.
import { plainText } from '../core/util.js';
import type { SandboxStatus } from '../core/types.js';
import { elapsed } from './progress.js';

/** One progress line: `line` is shown, `key` changes only when the step or what runs changes, `what` names it. */
export interface Shown { line: string; key: string; what: string }

const clean = (text: string, max: number): string => plainText(text).replace(/\s+/g, ' ').trim().slice(0, max);

/** "[3/8] Developer tools: downloading rust 40%, setting up go (2 of 6 done)". */
export const bootLine = (status: SandboxStatus | null, fallback = 'Starting Windows Sandbox'): Shown => {
  if (!status) return { line: fallback, key: fallback, what: fallback.toLowerCase() };
  const p = status.progress;
  if (!p) { const line = clean(status.message, 200) || fallback; return { line, key: line, what: line }; }
  const title = clean(p.title, 60);
  const items = p.active.slice(0, 8).map((a) => ({ name: clean(a.name, 40), percent: a.percent }));
  const loading = items.filter((a) => a.percent !== undefined && a.percent < 100);
  const others = items.filter((a) => !loading.includes(a));
  const parts = [
    ...(loading.length ? ['downloading ' + loading.map((a) => a.name + ' ' + a.percent + '%').join(', ')] : []),
    ...(others.length ? ['setting up ' + others.map((a) => a.name).join(', ')] : []),
  ];
  const count = p.total > 0 && items.length ? ' (' + Math.min(p.done, p.total) + ' of ' + p.total + ' done)' : '';
  const head = '[' + p.step + '/' + p.steps + '] ' + title;
  return {
    line: (head + (parts.length ? ': ' + parts.join('; ') : '') + count).slice(0, 240),
    key: head + '|' + items.map((a) => a.name).sort().join(','),
    what: items.length ? items.map((a) => a.name).join(', ') : title,
  };
};

/** Nothing new for a while: say so, and where the details are. */
export const stillWorking = (what: string, ms: number): string =>
  'Still working on ' + clean(what, 80) + ' (' + Math.max(1, Math.round(ms / 60000)) + ' min). Full log: sandbox logs -f';

export const readyIn = (ms: number): string => 'Ready in ' + elapsed(ms) + '.';

// ---- the first-start heads-up ----------------------------------------------------------------------------------------

/** What a first start downloads, by setting name: its folder in <data>\tools, rough size and a readable name. */
const DOWNLOADS: Record<string, { dir: string; mb: number; label?: string }> = {
  node: { dir: 'nvm', mb: 30 }, python: { dir: 'python', mb: 30 }, rust: { dir: 'rust', mb: 300 }, msvc: { dir: 'msvc', mb: 1500, label: 'MSVC' },
  cpp: { dir: 'mingw', mb: 270, label: 'C/C++' }, dotnet: { dir: 'dotnet', mb: 250, label: '.NET' }, go: { dir: 'go', mb: 80 }, java: { dir: 'java', mb: 200 },
  ruby: { dir: 'ruby', mb: 100 }, php: { dir: 'php', mb: 30 }, deno: { dir: 'deno', mb: 40 }, pwsh: { dir: 'pwsh', mb: 100, label: 'PowerShell 7' },
  vscode: { dir: 'vscode', mb: 150, label: 'VS Code' },
  postgres: { dir: 'postgres', mb: 330, label: 'PostgreSQL' }, mysql: { dir: 'mariadb', mb: 90, label: 'MariaDB' }, mongodb: { dir: 'mongodb', mb: 450, label: 'MongoDB' },
  redis: { dir: 'redis', mb: 10 }, dynamodb: { dir: 'dynamodb-local', mb: 80, label: 'DynamoDB Local' },
};

/** The wanted tools that are not downloaded yet (`has` says whether a folder in <data>\tools exists), with their rough size. */
export const pendingDownloads = (wanted: string[], has: (dir: string) => boolean): { names: string[]; mb: number } => {
  const missing = [...new Set(wanted)].filter((w) => Object.hasOwn(DOWNLOADS, w) && !has(DOWNLOADS[w].dir));
  return { names: missing.map((w) => DOWNLOADS[w].label ?? w), mb: missing.reduce((sum, w) => sum + DOWNLOADS[w].mb, 0) };
};

const roughSize = (mb: number): string => (mb >= 950 ? (Math.round(mb / 100) / 10) + ' GB' : Math.max(10, Math.round(mb / 10) * 10) + ' MB');

/** The heads-up before the wait, or null when everything is already downloaded. first: nothing was ever installed. */
export const firstStartNotice = (first: boolean, pending: { names: string[]; mb: number }): string | null => {
  if (!first && !pending.names.length) return null;
  const what = pending.names.length ? ' (about ' + roughSize(pending.mb) + ': ' + pending.names.slice(0, 8).join(', ') + (pending.names.length > 8 ? ', ...' : '') + ')' : '';
  return first
    ? 'First start: the sandbox downloads the tools this project needs once' + what + '. This can take 5-20 minutes depending on your connection; later starts take about a minute.'
    : 'New tools for this project: the sandbox downloads them once' + what + '. This can take a few minutes; later starts skip it.';
};
