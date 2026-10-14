// What a user may do with the one running Windows Sandbox, by whose it is. Pure: the caller finds the owner and acts on
// the answer. Windows allows one sandbox per PC and its window is on the desktop of the user who started it, so other
// users either share it (use its agents and commands, stop it with a typed confirmation) or can only look.
import { safeText } from '../../core/util/index.js';
import type { SandboxOwner } from './owner.js';

export type OwnerAction =
  /** status, sessions: always allowed; they say whose the sandbox is. */
  | { readonly kind: 'look' }
  /** attach, exec, db, an agent session in a project the sandbox already has. */
  | { readonly kind: 'use' }
  | { readonly kind: 'stop'; readonly sessions: number }
  /** restart, a new launch, showing the window: only whoever started it. `what` finishes "Only alice can ...". */
  | { readonly kind: 'owner-only'; readonly what: string; readonly window?: boolean };

export type OwnerRule =
  | { readonly kind: 'allow' }
  | { readonly kind: 'refuse'; readonly reason: string; readonly fix?: string }
  /** The user types `expected` (the owner's name, lower case) after reading `prompt`. */
  | { readonly kind: 'confirm'; readonly prompt: string; readonly expected: string };

const refuse = (reason: string, fix?: string): OwnerRule => ({ kind: 'refuse', reason, fix });

/** The owner's name as it is shown: text from another user's record never reaches the terminal raw. */
export const ownerName = (user: string): string => safeText(user);

export function ownerRule(owner: SandboxOwner, action: OwnerAction): OwnerRule {
  if (owner.kind === 'none' || owner.kind === 'mine' || action.kind === 'look') return { kind: 'allow' };
  if (owner.kind === 'unknown-other')
    return refuse(
      'A Windows Sandbox that someone else started is running on this PC, and it is not shared with you.',
      'Ask them to share it (the sharing.otherUsers setting), or start your own after it stops.',
    );
  const user = ownerName(owner.user);
  const notShared = (): OwnerRule =>
    refuse(
      user + "'s sandbox is not shared with you.",
      'Ask ' + user + ' to turn on sharing.otherUsers, or start your own after it stops.',
    );
  switch (action.kind) {
    case 'use':
      return owner.shared ? { kind: 'allow' } : notShared();
    case 'stop':
      if (!owner.shared) return notShared();
      return {
        kind: 'confirm',
        prompt:
          'This ends ' +
          user +
          "'s sandbox" +
          (action.sessions > 0 ? ' and its ' + action.sessions + ' session' + (action.sessions === 1 ? '' : 's') : '') +
          '.',
        expected: user.toLowerCase(),
      };
    case 'owner-only':
      if (action.window)
        return refuse(
          'The sandbox window is on ' +
            user +
            "'s desktop. Switch to " +
            user +
            "'s account to see it" +
            (owner.shared ? '; you can still use its agents here with sandbox attach.' : '.'),
        );
      return refuse('Only ' + user + ' can ' + action.what + ': the sandbox is theirs.');
  }
}

/** The message when a launch finds a sandbox of another user running (Windows allows one per PC). */
export function launchBlocked(owner: SandboxOwner): string | null {
  if (owner.kind === 'other') return 'A Windows Sandbox started by ' + ownerName(owner.user) + ' is already running';
  if (owner.kind === 'unknown-other') return 'A Windows Sandbox started by another user is already running';
  return null;
}

/** One line for status and the menu: whose sandbox is running and what that means for you. */
export function ownerLine(owner: SandboxOwner): string | null {
  if (owner.kind === 'other') {
    const user = ownerName(owner.user);
    return owner.shared
      ? 'Running, started by ' + user + ' (shared with you)'
      : 'Running, started by ' + user + ' (not shared)';
  }
  if (owner.kind === 'unknown-other') return 'Running, started by another user (not shared)';
  return null;
}
