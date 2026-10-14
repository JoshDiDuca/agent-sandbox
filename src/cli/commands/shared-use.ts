// Whose is the running sandbox? Windows allows one per PC, so with an all-users install another user's sandbox may be
// the one running. These helpers apply the rules in host/sharing/rules.ts: a command that only looks goes on whatever
// the owner (and says whose it is), a command that uses the sandbox goes on when it is shared (working on the owner's
// data folder, with none of this user's logins or agent environment), and the rest is the owner's alone.
import _ from 'lodash';
import { askTyped } from '../../core/prompt.js';
import type { LoadedConfig } from '../../core/types.js';
import { fail } from '../../core/util/index.js';
import { insideSandbox, isSandboxRunning } from '../../host/sandbox/index.js';
import {
  ownerLine,
  ownerName,
  ownerRule,
  runningOwner,
  sharedDataPath,
  type OwnerAction,
} from '../../host/sharing/index.js';
import type { SandboxOwner } from '../../host/sharing/owner.js';
import type { Context } from './context.js';

/** The sandbox is another user's and shared with this one. */
type SharedOwner = Extract<SandboxOwner, { kind: 'other' }>;

/** What the user's own settings must not carry into another user's sandbox: their agent environment values. */
function withoutHarnessEnvironment(loaded: LoadedConfig): LoadedConfig {
  return {
    ...loaded,
    config: {
      ...loaded.config,
      harnesses: _.mapValues(loaded.config.harnesses, (harness) => ({ ...harness, environment: {} })),
    },
  };
}

/**
 * The context for working in another user's shared sandbox: its data folder, its projects (from its record), and none
 * of this user's agent environment. A login chosen with --account would end up in their sandbox, so it is refused.
 */
export function borrowedContext(ctx: Context, owner: SharedOwner): Context {
  if (ctx.options.account)
    fail(
      '--account cannot be used in ' + ownerName(owner.user) + "'s sandbox.",
      'The sandbox uses the logins of ' + ownerName(owner.user) + '; yours stay on your side.',
    );
  return {
    ...ctx,
    dataPath: sharedDataPath(owner.record),
    loaded: withoutHarnessEnvironment(ctx.loaded),
    borrowed: { user: owner.user, record: owner.record },
  };
}

/** The running sandbox's owner, or null when there is nothing to ask (none running, or this is inside the sandbox). */
function ownerNow(): SandboxOwner | null {
  if (insideSandbox() || !isSandboxRunning()) return null;
  return runningOwner();
}

export interface SandboxView {
  /** Where to read from: the owner's data folder when the sandbox is another user's and shared. */
  readonly ctx: Context;
  /** "Running, started by alice (shared with you)", or null for your own sandbox. */
  readonly line: string | null;
  /** The sandbox is another user's and not shared: there is nothing to show but that. */
  readonly limited: boolean;
  readonly owner: SandboxOwner | null;
}

/** For status and sessions: they work for anyone, and say whose sandbox this is. */
export function lookAtSandbox(ctx: Context): SandboxView {
  const owner = ownerNow();
  if (!owner) return { ctx, line: null, limited: false, owner };
  const line = ownerLine(owner);
  if (owner.kind === 'other' && owner.shared) return { ctx: borrowedContext(ctx, owner), line, limited: false, owner };
  return { ctx, line, limited: owner.kind !== 'mine' && owner.kind !== 'none', owner };
}

/**
 * For a command that acts on the running sandbox: refuses with the reason when this user may not, asks for the typed
 * confirmation when the rule wants one (--yes in a script), and returns the context to use.
 */
export async function useSharedSandbox(
  ctx: Context,
  action: OwnerAction | ((shared: Context) => OwnerAction),
): Promise<Context> {
  const owner = ownerNow();
  if (!owner || owner.kind === 'mine' || owner.kind === 'none') return ctx;
  const target = owner.kind === 'other' && owner.shared ? borrowedContext(ctx, owner) : ctx;
  const rule = ownerRule(owner, typeof action === 'function' ? action(target) : action);
  if (rule.kind === 'refuse') return fail(rule.reason, rule.fix);
  if (rule.kind === 'confirm' && !ctx.options.yes) {
    if (!(process.stdin.isTTY && process.stdout.isTTY))
      fail(rule.prompt + ' It was not stopped.', 'In a script, add --yes to do it anyway.');
    if (!(await askTyped(rule.prompt, rule.expected))) fail('Nothing changed.');
  }
  return target;
}
