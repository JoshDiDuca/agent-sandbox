// The memory governor: samples the sandbox's memory every 2 seconds (memgov.exe, sandbox/csharp/MemGov.cs) and, when it
// runs low, slows the heaviest build programs the agents started down and, as a last resort, pauses the biggest
// compiler for a few seconds (decide.ts). What it does goes to the memory log and run\pressure.json, for the host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { PressureStatus } from '../../shared/channel/schema.js';
import { now } from '../../shared/channel/run-dir.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { GUEST_THRESHOLDS, maxCompilers, type LoadProfile } from '../../shared/memory/index.js';
import { ensureCompiled } from '../runtime/csc.js';
import { dataDir } from '../runtime/paths.js';
import { warn } from '../runtime/log.js';
import { run } from '../runtime/paths.js';
import { session } from '../runtime/session.js';
import { errMsg } from '../../core/util/errors.js';
import { decide, INITIAL_STATE, type Action, type GovernorState, type MemSample } from './decide.js';

const SampleSchema = z.object({
  ramTotalMb: z.number(),
  ramAvailMb: z.number(),
  commitLimitMb: z.number(),
  commitAvailMb: z.number(),
  procs: z
    .array(
      z.object({
        pid: z.number().int(),
        name: z.string().max(128),
        mb: z.number(),
        prio: z.enum(['idle', 'below', 'normal']).catch('normal'),
      }),
    )
    .max(1024),
});

/** What the governor needs from Windows (injectable: the tests use a fake). */
export interface GovernorPort {
  setPriority(pid: number, to: 'idle' | 'below' | 'normal'): void;
  pause(pid: number, ms: number): void;
}

/** Everything a step changes outside the decision, behind injectable functions. */
export interface GovernorDeps {
  readonly port: GovernorPort;
  readonly profile: LoadProfile;
  /** At most this many heavy compilers run at once (null = no cap). */
  readonly maxCompilers?: number | null;
  readonly now: () => number;
  /** A line in the memory log. */
  readonly logLine: (line: string) => void;
  /** run\pressure.json. */
  readonly saveStatus: (status: PressureStatus) => void;
}

/** The governor's logic over a port: feed it samples; the host's "slow down" requests go to hostPressure. */
export class GovernorCore {
  private state: GovernorState = INITIAL_STATE;
  private lastAction = '';
  private lastWrite = '';
  private lastWriteAt = 0;
  private pausedName = '';
  private pausedPid = 0;
  private held = new Set<number>();

  constructor(private readonly deps: GovernorDeps) {}

  hostPressure(seconds: number, reason: string): void {
    const until = this.deps.now() + seconds * 1000;
    if (until > this.state.hostUntil) {
      if (this.state.hostUntil <= this.deps.now())
        this.deps.logLine('governor: this PC is low (' + reason + '); slowing builds down');
      this.state = { ...this.state, hostUntil: until };
    }
  }

  get current(): GovernorState {
    return this.state;
  }

  onSample(sample: MemSample): void {
    const nowMs = this.deps.now();
    const before = this.state.pressure;
    const seen = new Set(sample.procs.map((p) => p.pid));
    for (const pid of this.held) if (!seen.has(pid)) this.held.delete(pid);
    const d = decide(
      this.state,
      sample,
      nowMs,
      GUEST_THRESHOLDS[this.deps.profile],
      this.deps.profile,
      this.deps.maxCompilers ?? null,
    );
    this.state = d.state;
    for (const action of d.actions) this.apply(action);
    if (d.state.pressure !== before)
      this.deps.logLine(
        d.state.pressure
          ? 'governor: memory is low (' +
              d.ramFreePercent +
              '% RAM free, commit ' +
              d.commitPercent +
              '% used): slowing builds down'
          : 'governor: memory is fine again: builds back to normal',
      );
    const paused =
      nowMs < d.state.pausedUntil && this.pausedPid
        ? [{ name: this.pausedName, pid: this.pausedPid, seconds: Math.ceil((d.state.pausedUntil - nowMs) / 1000) }]
        : [];
    const status: PressureStatus = {
      level: d.level,
      profile: this.deps.profile,
      ramFreePercent: Math.max(0, Math.min(100, d.ramFreePercent)),
      commitPercent: Math.max(0, Math.min(100, d.commitPercent)),
      lowered: Object.keys(d.state.lowered).length,
      paused,
      pcLow: nowMs < d.state.hostUntil,
      lastAction: this.lastAction,
      updatedAt: now(),
    };
    // Written when something changed, else once a minute (the host reads it, never polls it hard).
    const shape = JSON.stringify({ ...status, updatedAt: '', paused: paused.map((p) => p.pid) });
    if (shape !== this.lastWrite || nowMs - this.lastWriteAt > 60000) {
      this.lastWrite = shape;
      this.lastWriteAt = nowMs;
      this.deps.saveStatus(status);
    }
  }

  private apply(action: Action): void {
    try {
      if (action.kind === 'hold') {
        this.deps.port.pause(action.pid, action.ms);
        if (!this.held.has(action.pid)) {
          this.held.add(action.pid);
          this.lastAction = 'holding ' + action.name + ' (' + action.pid + ') until another compiler ends';
          this.deps.logLine('governor: ' + this.lastAction);
        }
        return;
      }
      if (action.kind === 'priority') {
        this.deps.port.setPriority(action.pid, action.to);
        this.lastAction = action.name + ' (' + action.pid + ') priority ' + action.to;
      } else {
        this.deps.port.pause(action.pid, action.ms);
        this.pausedName = action.name;
        this.pausedPid = action.pid;
        this.lastAction = 'paused ' + action.name + ' (' + action.pid + ') for ' + action.ms / 1000 + ' s';
        this.deps.logLine('governor: ' + this.lastAction);
        return;
      }
      this.deps.logLine('governor: ' + this.lastAction);
    } catch (e) {
      warn('governor: ' + errMsg(e));
    }
  }
}

/** memgov.exe as a child process: samples come out of its stdout, commands go into its stdin. */
class MemGovProcess implements GovernorPort {
  private child: ChildProcess | null = null;

  constructor(private readonly onSample: (s: MemSample) => void) {}

  start(): void {
    try {
      const child = spawn(ensureCompiled('memgov'), ['serve', '--interval', '2'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      this.child = child;
      createInterface({ input: child.stdout! }).on('line', (line) => {
        try {
          this.onSample(SampleSchema.parse(JSON.parse(line)));
        } catch (e) {
          warn('governor: bad sample: ' + errMsg(e));
        }
      });
      child.stdin!.on('error', () => undefined);
      child.once('exit', () => {
        this.child = null;
        // It ends only when something is wrong: try again in a while.
        setTimeout(() => this.start(), 30000).unref();
      });
    } catch (e) {
      warn('governor: could not start memgov.exe (no memory governor): ' + errMsg(e));
    }
  }

  setPriority(pid: number, to: 'idle' | 'below' | 'normal'): void {
    this.child?.stdin?.write('priority ' + pid + ' ' + to + '\n');
  }

  pause(pid: number, ms: number): void {
    this.child?.stdin?.write('suspend ' + pid + ' ' + ms + '\n');
  }
}

/** The newest memory log SandboxTools writes, to add the governor's lines to it. */
function appendToMemoryLog(line: string): void {
  try {
    const logs = path.join(dataDir, 'logs');
    const newest = fs
      .readdirSync(logs)
      .filter((f) => /^memory-\d{8}-\d{6}\.log$/.test(f))
      .sort()
      .pop();
    if (!newest) return;
    const t = new Date();
    const stamp = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    fs.appendFileSync(path.join(logs, newest), stamp + ' | ' + line + '\r\n');
  } catch {
    // The log is for people; a missing or locked one never matters.
  }
}

/** The daemon's governor: on unless sandbox.pressureResponse is off. */
export class Governor {
  private core: GovernorCore | null = null;

  describe(): string {
    const profile = session.loadProfile === 'gentle' ? 'gentle' : 'normal';
    const t = GUEST_THRESHOLDS[profile];
    return session.pressureResponse === false
      ? 'off (sandbox.pressureResponse)'
      : profile +
          ' profile: slows builds down below ' +
          t.enterAvailablePercent +
          '% free RAM or above ' +
          t.enterCommitPercent +
          '% commit';
  }

  start(): void {
    if (session.pressureResponse === false) return;
    const profile: LoadProfile = session.loadProfile === 'gentle' ? 'gentle' : 'normal';
    const proc = new MemGovProcess((s) => this.core?.onSample(s));
    this.core = new GovernorCore({
      port: proc,
      profile,
      maxCompilers: maxCompilers(os.cpus().length, profile),
      now: () => Date.now(),
      logLine: appendToMemoryLog,
      saveStatus: (status) => {
        try {
          writeJsonAtomic(run.pressureFile, status);
        } catch (e) {
          warn('governor: could not write its status: ' + errMsg(e));
        }
      },
    });
    proc.start();
  }

  /** The host's watchdog: this PC is low for a while. */
  hostPressure(seconds: number, reason: string): void {
    this.core?.hostPressure(seconds, reason);
  }
}

export const governor = new Governor();
