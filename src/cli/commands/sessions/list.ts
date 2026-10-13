import _ from 'lodash';
import type { SessionStatus } from '../../../core/types.js';
import { currentSessions } from '../../../host/channel/index.js';
import { sessionViewers } from '../../../host/channel/index.js';
import type { Viewers } from '../../../shared/pty/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { readRegistry, type RegistryEntry } from '../../../host/projects/index.js';
import { isWithin, projectForGuestDir } from '../../../shared/paths/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import { safeText } from '../../../core/util/index.js';
import { printJson, table } from '../../output/index.js';
import { type Context } from '../context.js';
import { locateHere } from '../projects/index.js';
import { ago, c, shortenMiddle, termWidth } from '../../output/index.js';

export const viewerText = (v: Viewers | null | undefined): string =>
  v === undefined
    ? '-'
    : v === null
      ? 'unknown (older session)'
      : v.remote + ' here, ' + (v.viewers - v.remote) + ' in sandbox';
export const projectOf = (projects: RegistryEntry[], s: SessionStatus): string =>
  s.project ?? projectForGuestDir(projects, s.cwd)?.name ?? '-';

type Listed = SessionStatus & { viewers?: Viewers | null; here?: boolean; projectName?: string };

/** Sessions with who is watching them; `here` marks the ones in the project of the current folder. */
export const listedSessions = async (ctx: Context): Promise<Listed[]> => {
  // Who is attached comes from each session itself, so a terminal that was closed is never counted.
  const live = isSandboxRunning();
  // Only this sandbox's sessions are asked (and at most MAX_QUERIED_SESSIONS): the sandbox writes these files.
  const ask = new Set(live ? currentSessions(ctx.dataPath).map((s) => s.id) : []);
  const here = live ? locateHere(ctx, new RunDir(ctx.dataPath).readSandboxStatus()) : { guestDir: null };
  const projects = readRegistry(ctx.storageRoot)?.projects ?? [];
  return Promise.all(
    new RunDir(ctx.dataPath).listSessions().map(async (s) => ({
      ...s,
      projectName: projectOf(projects, s),
      here: Boolean(here.guestDir && isWithin(here.guestDir, s.cwd)),
      ...(ask.has(s.id) ? { viewers: await sessionViewers(s) } : {}),
    })),
  );
};

export const sessions = async (ctx: Context): Promise<number> => {
  const list = await listedSessions(ctx);
  if (
    printJson(
      ctx,
      list.map((s) => _.omit(s, 'attach')),
    )
  )
    return 0;
  if (list.length === 0) {
    console.log('No sessions. Start one with: sandbox claude');
    return 0;
  }
  // This folder's project first, newest first within each group; harness, cwd and times are written by the sandbox.
  const ordered = [
    ..._.sortBy(
      list.filter((s) => s.here),
      (s) => s.startedAt,
    ).reverse(),
    ..._.sortBy(
      list.filter((s) => !s.here),
      (s) => s.startedAt,
    ).reverse(),
  ];
  const folderWidth = Math.max(16, termWidth() - 80);
  table([
    ['', 'ID', 'AGENT', 'PROJECT', 'STATE', 'ATTACHED', 'FOLDER', 'STARTED'],
    ...ordered.map((s) => [
      s.here ? '*' : '',
      s.id,
      safeText(s.harness),
      safeText(s.projectName ?? '-'),
      s.phase + (s.exitCode !== undefined ? ' (' + s.exitCode + ')' : ''),
      viewerText(s.viewers),
      shortenMiddle(safeText(s.cwd), folderWidth),
      ago(s.startedAt),
    ]),
  ]);
  if (list.some((s) => s.here)) console.log(c.dim('* = the project of this folder'));
  return 0;
};
