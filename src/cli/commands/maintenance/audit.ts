import path from 'node:path';
import { fail, plainText } from '../../../core/util/index.js';
import { humanBytes } from '../../../core/disk.js';
import { AuditLog } from '../../../host/audit/log.js';
import { printJson, c } from '../../output/index.js';
import { type Context } from '../context.js';

const KINDS = ['proc', 'file', 'session', 'guard', 'note'] as const;
const KIND_LABEL: Record<string, string> = {
  proc: 'program',
  file: 'file',
  session: 'session',
  guard: 'GUARD',
  note: 'note',
};

/** `sandbox audit`: the audit log of the last days (audit.enabled), newest last. */
export async function audit(ctx: Context): Promise<number> {
  const settings = ctx.loaded.config.audit;
  const kind = ctx.options.kind;
  if (kind && !(KINDS as readonly string[]).includes(kind))
    fail('Unknown kind "' + kind + '".', 'Use one of: ' + KINDS.join(', '));
  const log = new AuditLog(AuditLog.dirFor(ctx.storageRoot, ctx.dataPath), settings);
  const events = log.read({
    days: ctx.options.days,
    kinds: kind ? [kind as (typeof KINDS)[number]] : undefined,
    grep: ctx.options.grep,
  });
  if (printJson(ctx, events)) return 0;
  if (!events.length) {
    console.log(
      settings.enabled
        ? 'Nothing in the audit log for the last ' + ctx.options.days + ' day(s).'
        : 'The audit log is off. Turn it on in the menu (Settings > Security & privacy > Audit log) or with: sandbox config set audit.enabled true',
    );
    return 0;
  }
  for (const e of events) {
    // What the sandbox reported is text from the sandbox: no control codes reach your terminal.
    const [p, cmd, parent, dir, act] = [e.p, e.c, e.pp, e.w, e.a].map((v) => plainText(v ?? ''));
    const what =
      e.k === 'proc'
        ? (cmd || p) + (parent ? c.dim('  <- ' + path.win32.basename(parent)) : '')
        : e.k === 'file'
          ? act + ' ' + p + c.dim('  in ' + dir)
          : e.k === 'session'
            ? act + ' ' + p + c.dim('  ' + dir + ' ' + cmd)
            : p;
    console.log(
      c.dim(new Date(e.t).toLocaleString()) +
        '  ' +
        (e.k === 'guard' ? c.yellow(KIND_LABEL[e.k].padEnd(8)) : KIND_LABEL[e.k].padEnd(8)) +
        what +
        (e.n && e.n > 1 ? c.dim('  x' + e.n) : ''),
    );
  }
  console.log(
    c.dim(
      '\n' +
        events.length +
        ' event(s); the log takes ' +
        humanBytes(log.bytes()) +
        ' (' +
        AuditLog.dirFor(ctx.storageRoot, ctx.dataPath) +
        ').',
    ),
  );
  return 0;
}
