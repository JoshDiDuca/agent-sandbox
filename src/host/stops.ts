// Why the last sandbox stopped, when nobody stopped it. The background watcher writes a host-only "life" record (when
// the sandbox started, when it was last seen running, how it ended) and keeps this PC awake while it runs
// (sandbox.keepAwake). When the PC restarts, sleeps or crashes, the watcher stops too and the record has no end: the
// next launch reads Windows' System log from that moment on and says what happened, and what keeps it from happening.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { SYSTEM } from '../shared/system.js';
import { readValid, writeJsonAtomic } from '../shared/rundir.js';
import { isWin } from '../core/util.js';
import { refuseInSelfTest } from './test-guard.js';

const Iso = z.string().max(40);
const Life = z.object({
  started: Iso, lastSeen: Iso, keepAwake: z.boolean(),
  ended: z.object({ at: Iso, cause: z.object({ kind: z.enum(['updates', 'restart', 'crash', 'sleep', 'memory']), at: Iso, text: z.string().max(400) }).nullable() }).optional(),
  reported: z.boolean().optional(),
});
type LifeT = z.infer<typeof Life>;

const lifeFile = (storageRoot: string, dataPath: string): string => path.join(storageRoot, 'sync', path.basename(dataPath) + '-life.json');
export const readLife = (storageRoot: string, dataPath: string): LifeT | null => readValid(Life, lifeFile(storageRoot, dataPath));
const writeLife = (storageRoot: string, dataPath: string, life: LifeT): void => writeJsonAtomic(lifeFile(storageRoot, dataPath), life);

/** At launch: a fresh record (the previous one has been reported by then). */
export const startLife = (storageRoot: string, dataPath: string, keepAwake: boolean, now = new Date()): void =>
  writeLife(storageRoot, dataPath, { started: now.toISOString(), lastSeen: now.toISOString(), keepAwake });

/** Every minute while the sandbox runs. */
export const beatLife = (storageRoot: string, dataPath: string, now = new Date()): void => {
  const life = readLife(storageRoot, dataPath);
  if (life && !life.ended) writeLife(storageRoot, dataPath, { ...life, lastSeen: now.toISOString() });
};

/** The watcher saw the sandbox close while this PC kept running: closed by you (no cause), or by sleep / low memory. */
export const endLife = (storageRoot: string, dataPath: string, cause: StopCause | null, now = new Date()): void => {
  const life = readLife(storageRoot, dataPath);
  if (life && !life.ended) writeLife(storageRoot, dataPath, { ...life, ended: { at: now.toISOString(), cause } });
};

// ---- Windows' System log ----------------------------------------------------------------------------------------

export interface StopEvent { at: string; id: number; provider: string; process: string }
const StopEvents = z.array(z.object({ at: Iso, id: z.number().int(), provider: z.string().max(200), process: z.string().max(400).nullable().transform((p) => p ?? '') })).max(100);

export type StopKind = 'updates' | 'restart' | 'crash' | 'sleep' | 'memory';
export interface StopCause { kind: StopKind; at: string; text: string }

const UPDATERS = /^(trustedinstaller|mousocoreworker|musnotification(ux)?|usoclient|wuauclt|tiworker|updateorchestrator)\.exe$/i;

/** The first event that ends a running sandbox (pure): a restart or shutdown, a crash or power loss, sleep, low memory. */
export const explainStop = (events: StopEvent[]): StopCause | null => {
  const causes = events.flatMap((e): StopCause[] => {
    const p = e.provider.toLowerCase();
    if (e.id === 1074 && p.includes('user32')) {
      const exe = e.process.split(/[\\/]/).pop()?.replace(/\s*\(.*$/, '') ?? '';
      return UPDATERS.test(exe)
        ? [{ kind: 'updates', at: e.at, text: 'Windows restarted this PC to install updates' }]
        : [{ kind: 'restart', at: e.at, text: 'this PC was restarted or shut down' + (exe ? ' (by ' + exe + ')' : '') }];
    }
    if ((e.id === 41 && p.includes('kernel-power')) || (e.id === 6008 && p.includes('eventlog'))) return [{ kind: 'crash', at: e.at, text: 'Windows stopped unexpectedly (a crash, a power cut, or the power button held down)' }];
    if (e.id === 42 && p.includes('kernel-power')) return [{ kind: 'sleep', at: e.at, text: 'this PC went to sleep or hibernated' }];
    if (e.id === 2004 && p.includes('resource-exhaustion')) return [{ kind: 'memory', at: e.at, text: 'this PC ran out of memory' }];
    return [];
  });
  return causes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] ?? null;
};

const ADVICE: Record<StopKind, string> = {
  updates: 'Before leaving agents overnight, restart for pending updates first or pause them (Settings > Windows Update > Pause updates).',
  restart: 'If that was not you, check Settings > Windows Update and Event Viewer > Windows Logs > System.',
  crash: 'Event Viewer > Windows Logs > System has the details; a laptop also needs to stay plugged in.',
  sleep: 'sandbox.keepAwake keeps this PC awake while a sandbox runs (closing a laptop lid still sleeps it). Check it is on, and that sleep is not forced by a policy.',
  memory: 'Give the sandbox less RAM (sandbox.maxMemoryMb, sandbox.reserveHostMb) or run fewer builds at once inside it.',
};

/** System log events since `since` that can end a sandbox (Windows only; empty when the log cannot be read). */
export const readStopEvents = (since: Date): StopEvent[] => {
  if (!isWin) return [];
  refuseInSelfTest('read the Windows event log');
  const script = "$ErrorActionPreference='SilentlyContinue'; $e = Get-WinEvent -FilterHashtable @{LogName='System'; Id=1074,6008,41,42,2004; StartTime=[datetime]::Parse('" + since.toISOString() + "').ToLocalTime()} -MaxEvents 100 | ForEach-Object { [pscustomobject]@{ at=$_.TimeCreated.ToUniversalTime().ToString('o'); id=$_.Id; provider=$_.ProviderName; process=$(if ($_.Id -eq 1074) { [string]$_.Properties[0].Value } else { '' }) } }; ConvertTo-Json -Compress -InputObject @($e)";
  const result = spawnSync(SYSTEM.powershell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  try { return StopEvents.parse(JSON.parse(result.stdout || '[]')); } catch { return []; }
};

/** Looking back from the last time the sandbox was seen running (a minute between checks, plus margin). */
export const causeSince = (lastSeen: string): StopCause | null => explainStop(readStopEvents(new Date(Date.parse(lastSeen) - 2 * 60 * 1000)));

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * At launch: one warning when the last sandbox ended without anyone closing it (the PC restarted, crashed, slept or ran
 * out of memory), then never again for that run. `watcherAlive` = its watcher is still running (then it did not end).
 */
export const lastStopWarning = (storageRoot: string, dataPath: string, watcherAlive: boolean, find = causeSince): string | null => {
  const life = readLife(storageRoot, dataPath);
  if (!life || life.reported || watcherAlive) return null;
  writeLife(storageRoot, dataPath, { ...life, reported: true });
  if (life.ended && !life.ended.cause) return null;
  const cause = life.ended ? life.ended.cause : find(life.lastSeen);
  const what = cause ? cause.text + ' at ' + when(cause.at) + '. ' + ADVICE[cause.kind] : 'this PC stopped (Windows logged no reason). ' + ADVICE.crash;
  return 'The last sandbox did not close normally: it was last seen running at ' + when(life.lastSeen) + ', and ' + what + ' Agent conversations are kept: /resume in Claude picks one up.';
};

// ---- Windows Update and keeping awake ----------------------------------------------------------------------------

/** Windows has installed updates and waits to restart: it may do so on its own, outside your active hours. */
export const updateRestartPending = (): boolean => isWin && [
  'HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\Auto Update\\RebootRequired',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending',
].some((key) => spawnSync(SYSTEM.reg(), ['query', key], { windowsHide: true, stdio: 'ignore', timeout: 15000 }).status === 0);

export const UPDATE_RESTART_WARNING = 'Windows is waiting to restart for updates and may do so on its own (often overnight), which closes the sandbox. Restart first, or pause updates: Settings > Windows Update > Pause updates.';

/**
 * sandbox.keepAwake: asks Windows not to sleep while the sandbox runs (as a video player does; the screen may still turn
 * off). A small PowerShell holds the request until `ownerPid` exits, so it never outlives the watcher.
 */
export const keepAwake = (ownerPid: number): ChildProcess | null => {
  if (!isWin) return null;
  refuseInSelfTest('keep this PC awake');
  const script = "Add-Type -Name Power -Namespace AgentSandbox -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; "
    + '[void][AgentSandbox.Power]::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id ' + Math.trunc(ownerPid) + ' -ErrorAction SilentlyContinue';
  const child = spawn(SYSTEM.powershell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  return child;
};
