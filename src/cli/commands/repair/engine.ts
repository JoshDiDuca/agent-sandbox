// The engine behind doctor and repair: runs the checks in order (grouped), each with its own time limit, tells a hook
// as each one starts and ends, then applies the fixes you agreed to and looks again to see they worked. Never prints.
import { errMsg, UserError } from '../../../core/util/index.js';
import {
  CHECK_GROUPS,
  WHILE_RUNNING,
  type Check,
  type CheckResult,
  type Finding,
  type RepairEnv,
  type Summary,
} from './types.js';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const FIX_TIMEOUT_MS = 120_000;

/** What the output hooks into: each step, as it happens. */
export interface RunHooks {
  lookStart?: (check: Check) => void;
  lookEnd?: (result: CheckResult) => void;
  fixStart?: (result: CheckResult) => void;
  fixEnd?: (result: CheckResult) => void;
}

class TimedOut extends Error {}

/** Resolves with `work`, or rejects with TimedOut after `ms` (a check that blocks the process cannot be stopped). */
export function withTimeout<T>(work: () => T | Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimedOut()), ms);
    Promise.resolve()
      .then(work)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
  });
}

/** The checks in the order they are shown: by group, then as listed. */
export function inGroupOrder(checks: readonly Check[]): Check[] {
  return [...checks].sort((a, b) => CHECK_GROUPS.indexOf(a.group) - CHECK_GROUPS.indexOf(b.group));
}

export function summarize(results: readonly CheckResult[]): Summary {
  const count = (status: CheckResult['status']): number => results.filter((r) => r.status === status).length;
  return {
    total: results.length,
    ok: count('ok'),
    fixed: count('fixed'),
    warn: count('warn'),
    needsYou: count('needs-you'),
    skipped: count('skipped'),
    fixable: results.filter((r) => r.fixable && r.status !== 'fixed').length,
  };
}

const withUserFix = (e: unknown): string => errMsg(e) + (e instanceof UserError && e.fix ? ' ' + e.fix : '');

export class HealthRun {
  private readonly findings = new Map<string, Finding>();
  private readonly checks: Check[];

  constructor(
    checks: readonly Check[],
    private readonly env: RepairEnv,
    private readonly hooks: RunHooks = {},
    private readonly limits: { lookMs?: number; fixMs?: number } = {},
  ) {
    this.checks = inGroupOrder(checks);
  }

  /** Runs every check without changing anything. */
  async look(): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const check of this.checks) {
      if (check.applies && !check.applies(this.env)) continue;
      this.hooks.lookStart?.(check);
      const result = await this.lookAt(check);
      results.push(result);
      this.hooks.lookEnd?.(result);
    }
    return results;
  }

  /** Applies the fix of every result repair can mend (or only those in `only`), then looks again. */
  async fix(results: readonly CheckResult[], only?: readonly string[]): Promise<CheckResult[]> {
    const out: CheckResult[] = [];
    for (const result of results) {
      const check = this.checks.find((c) => c.id === result.id);
      const finding = this.findings.get(result.id);
      if (!check?.fix || !finding || !result.fixable || (only && !only.includes(result.id))) {
        out.push(result);
        continue;
      }
      this.hooks.fixStart?.(result);
      const after = await this.fixOne(check, finding, result);
      out.push(after);
      this.hooks.fixEnd?.(after);
    }
    return out;
  }

  private async lookAt(check: Check): Promise<CheckResult> {
    const started = Date.now();
    const base = { id: check.id, group: check.group, name: check.name };
    if (check.needsIdle === 'look' && this.env.running)
      return { ...base, status: 'skipped', detail: WHILE_RUNNING, fixable: false, ms: 0 };
    let finding: Finding;
    try {
      finding = await withTimeout(
        () => check.run(this.env),
        check.timeoutMs ?? this.limits.lookMs ?? DEFAULT_TIMEOUT_MS,
      );
    } catch (e) {
      const ms = Date.now() - started;
      if (e instanceof TimedOut)
        return { ...base, status: 'skipped', detail: 'took too long, skipped', timedOut: true, fixable: false, ms };
      return { ...base, status: 'needs-you', detail: 'the check failed: ' + withUserFix(e), fixable: false, ms };
    }
    this.findings.set(check.id, finding);
    return {
      ...base,
      status: finding.status,
      detail: finding.detail,
      means: finding.means,
      fix: finding.fix,
      plan: finding.plan,
      lines: finding.lines,
      fixable: Boolean(check.fix && finding.plan && finding.status !== 'ok'),
      ms: Date.now() - started,
    };
  }

  private async fixOne(check: Check, finding: Finding, result: CheckResult): Promise<CheckResult> {
    if (check.needsIdle && this.env.running)
      return { ...result, status: 'skipped', detail: WHILE_RUNNING, fixable: false };
    try {
      const outcome = await withTimeout(
        () => check.fix?.(this.env, finding) ?? { done: '' },
        this.limits.fixMs ?? FIX_TIMEOUT_MS,
      );
      const again = await this.lookAt(check);
      const applied = { done: outcome.done, before: result.detail, after: again.detail };
      if (again.status === 'ok') return { ...again, status: 'fixed', detail: outcome.done, fixable: false, applied };
      return { ...again, fixable: false, applied, error: 'it is still not right after the fix' };
    } catch (e) {
      const why = e instanceof TimedOut ? 'took too long' : withUserFix(e);
      return { ...result, status: 'needs-you', error: why, fixable: false, detail: result.detail };
    }
  }
}
