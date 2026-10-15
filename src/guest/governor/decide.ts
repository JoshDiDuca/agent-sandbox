// The memory governor's decisions (pure): given a memory sample and what it did before, which programs in the agents'
// job to slow down or pause. Nothing here touches Windows; governor.ts carries the actions out through a port.
import type { GuestThresholds, LoadProfile } from '../../shared/memory/index.js';

export type Priority = 'idle' | 'below' | 'normal';

export interface ProcSample {
  readonly pid: number;
  readonly name: string;
  /** Private memory in MB. */
  readonly mb: number;
  readonly prio: Priority;
}

export interface MemSample {
  readonly ramTotalMb: number;
  readonly ramAvailMb: number;
  readonly commitLimitMb: number;
  readonly commitAvailMb: number;
  /** Only the processes in the agents' job. */
  readonly procs: readonly ProcSample[];
}

/** Programs that compile or link: they may be slowed down and, as the last resort, paused for a few seconds. */
const COMPILERS = new Set([
  'rustc',
  'clippy-driver',
  'rustdoc',
  'cc1',
  'cc1plus',
  'cc1obj',
  'collect2',
  'gcc',
  'g++',
  'c++',
  'cc',
  'clang',
  'clang++',
  'clang-cl',
  'cl',
  'link',
  'lld',
  'lld-link',
  'ld',
  'ld.lld',
  'as',
  'tsc',
  'javac',
]);
/** Build tools and workers: slowed down but never paused (a node process may be a dev server or an agent). */
const BUILD_TOOLS = new Set([
  'node',
  'dotnet',
  'msbuild',
  'vbcscompiler',
  'ninja',
  'make',
  'mingw32-make',
  'cmake',
  'cargo',
  'go',
  'java',
  'gradle',
  'python',
]);
/** Never touched: the agents themselves, shells, terminals, this tool's own programs, Windows. */
const NEVER = new Set([
  'claude',
  'codex',
  'gemini',
  'opencode',
  'aider',
  'cursor-agent',
  'cmd',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'zsh',
  'git',
  'conhost',
  'openconsole',
  'windowsterminal',
  'wt',
  'ptyhost',
  'memgov',
  'sandboxtools',
  'sbx-db',
  'explorer',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'svchost',
  'lsass',
  'system',
  'smss',
  'dwm',
]);

const key = (name: string): string => name.toLowerCase().replace(/\.exe$/, '');

export const isNeverTouched = (name: string): boolean => NEVER.has(key(name));
export const canLower = (name: string): boolean =>
  !isNeverTouched(name) && (COMPILERS.has(key(name)) || BUILD_TOOLS.has(key(name)));
/** The heavy ones the concurrency cap counts (drivers like gcc and collect2 only wait for these). */
const HEAVY = new Set([
  'rustc',
  'clippy-driver',
  'rustdoc',
  'cc1',
  'cc1plus',
  'clang',
  'clang++',
  'clang-cl',
  'cl',
  'link',
  'lld',
  'lld-link',
  'ld',
  'ld.lld',
]);
export const isHeavyCompiler = (name: string): boolean => !isNeverTouched(name) && HEAVY.has(key(name));
export const canPause = (name: string): boolean => !isNeverTouched(name) && COMPILERS.has(key(name));

export type Level = 'ok' | 'throttled' | 'suspending';

export interface GovernorState {
  /** Under pressure now (with hysteresis). */
  readonly pressure: boolean;
  /** Samples in a row that looked calm while under pressure. */
  readonly calm: number;
  /** Samples under pressure so far (resets when it ends). */
  readonly samples: number;
  /** What was lowered and to what, by pid. */
  readonly lowered: Readonly<Record<number, Priority>>;
  /** Until when (ms) the last pause lasts, and when another may start. */
  readonly pausedUntil: number;
  readonly nextPauseAt: number;
  /** The PC asked for slowing down until this time (ms). */
  readonly hostUntil: number;
}

export const INITIAL_STATE: GovernorState = {
  pressure: false,
  calm: 0,
  samples: 0,
  lowered: {},
  pausedUntil: 0,
  nextPauseAt: 0,
  hostUntil: 0,
};

export type Action =
  | { readonly kind: 'priority'; readonly pid: number; readonly name: string; readonly to: Priority }
  | { readonly kind: 'pause'; readonly pid: number; readonly name: string; readonly ms: number }
  /** Waits (suspended) because more compilers run than the cap allows; repeated while it is over, never killed. */
  | { readonly kind: 'hold'; readonly pid: number; readonly name: string; readonly ms: number };

/** How long a held compiler waits before it gets a turn again (the governor repeats the hold while over the cap). */
export const HOLD_MS = 3000;

export interface Decision {
  readonly state: GovernorState;
  readonly actions: readonly Action[];
  readonly level: Level;
  readonly ramFreePercent: number;
  readonly commitPercent: number;
}

export const PAUSE_MS = 5000;
const PAUSE_COOLDOWN_MS = 10000;
/** Samples under pressure before programs go from below-normal to idle, and before one is paused. */
const IDLE_AFTER = 3;
const PAUSE_AFTER = 4;
/** Only a program this big is worth pausing. */
const PAUSE_MIN_MB = 300;

/**
 * One step. `gentle` (vGPU on): compilers start below normal even without pressure. Programs go back to their normal
 * priority only when pressure ends (several calm samples in a row).
 */
export function decide(
  prev: GovernorState,
  sample: MemSample,
  nowMs: number,
  thresholds: GuestThresholds,
  profile: LoadProfile,
  maxCompilers: number | null = null,
): Decision {
  const ramFree = (sample.ramAvailMb / Math.max(1, sample.ramTotalMb)) * 100;
  const commit = ((sample.commitLimitMb - sample.commitAvailMb) / Math.max(1, sample.commitLimitMb)) * 100;
  const pcLow = nowMs < prev.hostUntil;
  const low = ramFree < thresholds.enterAvailablePercent || commit > thresholds.enterCommitPercent || pcLow;
  const recovered = ramFree > thresholds.exitAvailablePercent && commit < thresholds.exitCommitPercent && !pcLow;

  let pressure = prev.pressure;
  let calm = prev.calm;
  let samples = prev.samples;
  if (low) {
    pressure = true;
    calm = 0;
    samples = prev.samples + 1;
  } else if (prev.pressure) {
    calm = recovered ? prev.calm + 1 : 0;
    if (calm >= thresholds.calmSamples) {
      pressure = false;
      calm = 0;
      samples = 0;
    }
  }

  const actions: Action[] = [];
  const present = new Set(sample.procs.map((p) => p.pid));
  const lowered: Record<number, Priority> = {};
  for (const [pid, to] of Object.entries(prev.lowered)) if (present.has(Number(pid))) lowered[Number(pid)] = to;

  if (pressure) {
    const target: Priority = samples > IDLE_AFTER ? 'idle' : 'below';
    for (const p of sample.procs) {
      if (!canLower(p.name) || lowered[p.pid] === target) continue;
      // Already as low as asked (or lower): only remember it.
      if (p.prio !== target && !(target === 'below' && p.prio === 'idle'))
        actions.push({ kind: 'priority', pid: p.pid, name: p.name, to: target });
      lowered[p.pid] = target;
    }
  } else {
    for (const p of sample.procs) {
      if (!canLower(p.name)) continue;
      // Where a program rests when nothing is wrong: compilers below normal in the gentle profile.
      const base: Priority = profile === 'gentle' && canPause(p.name) ? 'below' : 'normal';
      const was = lowered[p.pid];
      if (prev.pressure && was !== undefined && was !== base) {
        if (p.prio !== base) actions.push({ kind: 'priority', pid: p.pid, name: p.name, to: base });
        if (base === 'normal') delete lowered[p.pid];
        else lowered[p.pid] = base;
      } else if (!prev.pressure && base === 'below' && was === undefined) {
        if (p.prio === 'normal') actions.push({ kind: 'priority', pid: p.pid, name: p.name, to: 'below' });
        lowered[p.pid] = 'below';
      }
    }
  }

  let pausedUntil = prev.pausedUntil;
  let nextPauseAt = prev.nextPauseAt;
  if (pressure && samples >= PAUSE_AFTER && nowMs >= prev.nextPauseAt && nowMs >= prev.pausedUntil) {
    const victim = [...sample.procs]
      .filter((p) => canPause(p.name) && p.mb >= PAUSE_MIN_MB)
      .sort((a, b) => b.mb - a.mb)[0];
    if (victim) {
      actions.push({ kind: 'pause', pid: victim.pid, name: victim.name, ms: PAUSE_MS });
      pausedUntil = nowMs + PAUSE_MS;
      nextPauseAt = pausedUntil + PAUSE_COOLDOWN_MS;
    }
  }

  // Concurrency cap (vGPU profile): the oldest N heavy compilers run, the newer ones wait a few seconds at a time.
  if (maxCompilers !== null) {
    const heavy = sample.procs
      .filter(
        (p) =>
          isHeavyCompiler(p.name) &&
          !(nowMs < pausedUntil && actions.some((a) => a.kind === 'pause' && a.pid === p.pid)),
      )
      .sort((a, b) => a.pid - b.pid);
    for (const p of heavy.slice(Math.max(1, maxCompilers)))
      actions.push({ kind: 'hold', pid: p.pid, name: p.name, ms: HOLD_MS });
  }

  const level: Level = nowMs < pausedUntil ? 'suspending' : pressure ? 'throttled' : 'ok';
  return {
    state: { pressure, calm, samples, lowered, pausedUntil, nextPauseAt, hostUntil: prev.hostUntil },
    actions,
    level,
    ramFreePercent: Math.round(ramFree),
    commitPercent: Math.round(commit),
  };
}
