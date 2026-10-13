// One line of progress from the guest's status while a sandbox starts. Pure: the status is guest-written, so every
// bit of it is made safe and short here.
import { plainText } from '../../../core/util/index.js';
import type { SandboxStatus } from '../../../core/types.js';
import { elapsed, type Progressing } from '../../output/index.js';

function clean(text: string, max: number): string {
  return plainText(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** "[3/8] Developer tools: downloading rust 40%, setting up go (2 of 6 done)". */
export function bootLine(status: SandboxStatus | null, fallback = 'Starting Windows Sandbox'): Progressing {
  if (!status) return { line: fallback, key: fallback, what: fallback.toLowerCase() };
  const p = status.progress;
  if (!p) {
    const line = clean(status.message, 200) || fallback;
    return { line, key: line, what: line };
  }
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
    key:
      head +
      '|' +
      items
        .map((a) => a.name)
        .sort()
        .join(','),
    what: items.length ? items.map((a) => a.name).join(', ') : title,
  };
}

/** Nothing new for a while: say so, and where the details are. */
export function stillWorking(what: string, ms: number): string {
  return (
    'Still working on ' +
    clean(what, 80) +
    ' (' +
    Math.max(1, Math.round(ms / 60000)) +
    ' min). Full log: sandbox logs -f'
  );
}

export function readyIn(ms: number): string {
  return 'Ready in ' + elapsed(ms) + '.';
}
