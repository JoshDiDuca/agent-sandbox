// A launch after a sandbox that had agent sessions: say what ran last time and, as `resume.sessions` says, ask whether
// to open it again, do it, or only name the command. The sessions open once the new sandbox is ready (launch.ts).
import { askYesNo } from '../../../core/prompt.js';
import type { ResolvedRun } from '../../../core/types.js';
import { describeLast, LifeRecord, SessionLedger, shouldReopen } from '../../../host/life/index.js';
import { watcherRunning } from '../../../sync/index.js';
import { c } from '../../output/index.js';
import type { Context } from '../context.js';
import { ledgerToReopen, notRunningYet, type Reopen } from '../sessions/reopen.js';

/** Says the watcher gave up restarting the sandbox by itself (once). */
function sayGaveUp(ledger: SessionLedger): void {
  if (ledger.takeGaveUp())
    console.log(
      c.yellow(
        'The sandbox ended unexpectedly three times in six hours, so it was not started again by itself (resume.restartAfterCrash). sandbox resume starts it and reopens its sessions.',
      ),
    );
}

/**
 * The sessions to open once this launch's sandbox is ready: none unless resume.sessions says so (and, for "ask", you
 * say yes). Call it before the launch overwrites the record of how the last sandbox lived.
 */
export async function sessionsToResume(ctx: Context, run: ResolvedRun): Promise<Reopen[]> {
  const { storageRoot, dataPath } = ctx;
  const store = new SessionLedger(storageRoot, dataPath);
  sayGaveUp(store);
  const saved = store.read();
  const life = new LifeRecord(storageRoot, dataPath).read();
  const decision = shouldReopen(ctx.loaded.config.resume.sessions, life, saved, watcherRunning(dataPath));
  if (decision === 'no' || !saved) return [];
  // The session this launch starts by itself is not opened twice.
  const mine = ctx.options.noAgent ? [] : [{ harness: run.harnessName, hostDir: run.workspaceHost }];
  const reopen = notRunningYet(ledgerToReopen(saved.sessions), mine);
  if (!reopen.length) return [];
  const last = describeLast(saved.sessions);
  if (decision === 'reopen') {
    console.log('Last time: ' + last + '.');
    return reopen;
  }
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    console.log('Last time: ' + last + '. To open them again: sandbox resume');
    return [];
  }
  return (await askYesNo('Last time: ' + last + '. Reopen them?', true)) ? reopen : [];
}
