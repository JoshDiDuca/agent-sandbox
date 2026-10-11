// Path translation between this PC and the sandbox (shared by the host history sync and the guest plugin fix-up).

import { sandboxFolder } from './guest-paths.js';

/** Claude Code's per-project folder name: every non-alphanumeric character becomes '-' (F:\A\b -> F--A-b). */
export const projectFolderName = (workspace: string): string => workspace.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Every path the guest may know its workspace by, the real one first: a mirrored F:\A\b is a subst drive onto
 * C:\Mirror\F\A\b, and programs that resolve real paths (realpath, GetFinalPathNameByHandle) report that one.
 */
export const guestWorkspaceAliases = (guestWorkspace: string): string[] => {
  const real = sandboxFolder(guestWorkspace);
  return real.toLowerCase() === guestWorkspace.toLowerCase() ? [guestWorkspace] : [real, guestWorkspace];
};

const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * A file or folder name that is safe to recreate on this PC. The sandbox can create names Windows would treat as devices
 * (CON.jsonl opens the console), as streams (a:b), or that end in a dot or space (silently renamed); none of them are copied.
 */
export const isSafeFileName = (name: string): boolean =>
  name !== '' && name.length <= 200 && name !== '.' && name !== '..' && !/[<>:"|?*/\\\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !DEVICE_NAME.test(name);

const jsonEscaped = (p: string): string => JSON.stringify(p).slice(1, -1);
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const forward = (p: string): string => p.replace(/\\/g, '/');

/** Rewrites `from` to `to` wherever it appears as a whole path (raw, JSON-escaped or with forward slashes). */
export const translatePaths = (text: string, from: string, to: string): string => {
  if (from.toLowerCase() === to.toLowerCase()) return text;
  const pairs: [string, string][] = [[jsonEscaped(from), jsonEscaped(to)], [from, to], [forward(from), forward(to)]];
  return pairs.reduce((out: string, [a, b]) => out.replace(new RegExp(escapeRegex(a) + '(?=\\\\|/|"|\'|\\s|$)', 'gi'), b.replace(/\$/g, '$$$$')), text);
};
