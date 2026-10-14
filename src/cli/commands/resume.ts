// `sandbox resume`: open the sessions of the last sandbox again. Starts the sandbox the way it was started when none
// runs. `--auto` is how the background watcher calls it after a crash (resume.restartAfterCrash): no questions, and the
// resume.sessions setting decides whether the sessions open ("ask" counts as "always" there: nobody is at the PC).
import { sleep } from '../../core/util/index.js';
import { SandboxChannel } from '../../host/channel/index.js';
import { describeLast, LifeRecord, SessionLedger, shouldReopen, type Ledger } from '../../host/life/index.js';
import { ProjectRegistry } from '../../host/projects/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import { requireOnPc, type Context } from './context.js';
import { launch, RELAUNCHER } from './launch/index.js';
import {
  freshContext,
  ledgerToReopen,
  notRunningYet,
  reopenedText,
  reopenSessions,
  sessionsToReopen,
} from './sessions/reopen.js';

/** Windows Sandbox needs a moment after the old one is gone before a new one can start. */
const SETTLE_SECONDS = 30;

/** Starts the sandbox again the way the ledger says it was started: its launch folder, agent and projects. */
async function startAgain(ctx: Context, saved: Ledger): Promise<number> {
  const again = freshContext(ctx, saved.launch.primary, saved.launch.harness ?? undefined, {
    noAgent: saved.launch.harness === null,
    headless: saved.launch.headless ? true : undefined,
  });
  return launch(again, false, { extraProjects: saved.launch.projects, autoSession: false, waitUntilReady: true });
}

export async function resume(ctx: Context): Promise<number> {
  requireOnPc('resume');
  const { storageRoot, dataPath, options } = ctx;
  const saved = new SessionLedger(storageRoot, dataPath).read();
  if (!saved) {
    console.log('Nothing to reopen: no sandbox of this tool has been recorded yet.');
    return 0;
  }
  // By hand, you asked for it. From the watcher, the setting decides.
  const setting = ctx.loaded.config.resume.sessions;
  const life = new LifeRecord(storageRoot, dataPath).read();
  const reopening = !options.auto || shouldReopen(setting === 'ask' ? 'always' : setting, life, saved) === 'reopen';
  if (!options.auto && !saved.sessions.length) {
    console.log('Nothing to reopen: no agent sessions were running in the last sandbox.');
    return 0;
  }
  if (reopening && saved.sessions.length) console.log('Last time: ' + describeLast(saved.sessions) + '.');
  if (options.auto) for (let i = 0; i < SETTLE_SECONDS && isSandboxRunning(); i++) await sleep(1000);
  if (!isSandboxRunning()) {
    const code = await startAgain(ctx, saved);
    if (code !== 0) return code;
  }
  if (!reopening || !saved.sessions.length) return 0;

  const ready = await RELAUNCHER.readySandbox(ctx.dataPath);
  const registry = new ProjectRegistry(storageRoot).read();
  const open = registry ? sessionsToReopen(registry, new SandboxChannel(dataPath).currentSessions()) : [];
  const reopen = notRunningYet(ledgerToReopen(saved.sessions), open);
  if (!reopen.length) {
    console.log('Everything from the last sandbox is open already.');
    return 0;
  }
  const opened = await reopenSessions(ctx, ready, reopen, RELAUNCHER);
  console.log(reopenedText(opened, reopen.length, reopen));
  return opened === reopen.length ? 0 : 1;
}
