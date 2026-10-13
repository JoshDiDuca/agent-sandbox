import { type StopKind, causeSince } from './stop-events.js';
import { readLife, writeLife } from './life-record.js';

const ADVICE: Record<StopKind, string> = {
  updates:
    'Before leaving agents overnight, restart for pending updates first or pause them (Settings > Windows Update > Pause updates).',
  restart: 'If that was not you, check Settings > Windows Update and Event Viewer > Windows Logs > System.',
  crash: 'Event Viewer > Windows Logs > System has the details; a laptop also needs to stay plugged in.',
  sleep:
    'sandbox.keepAwake keeps this PC awake while a sandbox runs (closing a laptop lid still sleeps it). Check it is on, and that sleep is not forced by a policy.',
  sandboxCrash:
    'C:\\AgentData\\logs\\memory-*.log shows what used memory just before. Fewer builds at once inside the sandbox (e.g. cargo build.jobs) makes it less likely.',
  memory:
    'Give the sandbox less RAM (sandbox.maxMemoryMb, sandbox.reserveHostMb) or run fewer builds at once inside it.',
};

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * At launch: one warning when the last sandbox ended without anyone closing it (the PC restarted, crashed, slept or ran
 * out of memory), then never again for that run. `watcherAlive` = its watcher is still running (then it did not end).
 */
export const lastStopWarning = (
  storageRoot: string,
  dataPath: string,
  watcherAlive: boolean,
  find = causeSince,
): string | null => {
  const life = readLife(storageRoot, dataPath);
  if (!life || life.reported || watcherAlive) return null;
  writeLife(storageRoot, dataPath, { ...life, reported: true });
  if (life.ended && !life.ended.cause) return null;
  const cause = life.ended ? life.ended.cause : find(life.lastSeen);
  const what = cause
    ? cause.text + ' at ' + when(cause.at) + '. ' + ADVICE[cause.kind]
    : 'this PC stopped (Windows logged no reason). ' + ADVICE.crash;
  return (
    'The last sandbox did not close normally: it was last seen running at ' +
    when(life.lastSeen) +
    ', and ' +
    what +
    ' Agent conversations are kept: /resume in Claude picks one up.'
  );
};
