import _ from 'lodash';
import { safeText } from '../../../core/util/index.js';
import { printJson, table, ago, c, shortenMiddle, termWidth } from '../../output/index.js';
import { SessionsService, viewerText } from '../../services/index.js';
import { type Context } from '../context.js';
import { lookAtSandbox } from '../shared-use.js';

export async function sessions(asked: Context): Promise<number> {
  // Another user's sandbox: shared, its sessions are listed from their folders; not shared, only whose it is.
  const view = lookAtSandbox(asked);
  const ctx = view.ctx;
  if (view.limited) {
    if (!printJson(ctx, [])) console.log(view.line);
    return 0;
  }
  if (view.line && !ctx.options.json) console.log(c.bold(view.line));
  const service = new SessionsService(ctx);
  const list = await service.list();
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
  // Harness, cwd and times are written by the sandbox.
  const folderWidth = Math.max(16, termWidth() - 80);
  table([
    ['', 'ID', 'AGENT', 'PROJECT', 'STATE', 'ATTACHED', 'FOLDER', 'STARTED'],
    ...service
      .ordered(list)
      .map((s) => [
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
}
