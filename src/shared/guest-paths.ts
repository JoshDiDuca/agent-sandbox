// Guest paths on drive letters other than C:. Windows Sandbox can only map folders onto its own C: drive, so a
// guest path like F:\SteamLibrary\x is mapped to C:\Mirror\F\SteamLibrary\x and, at boot (bootstrap.ps1, before
// anything else uses the workspace), `subst F: C:\Mirror\F` makes it appear at F:\SteamLibrary\x.
// Pure functions only: used by the schema, the host (.wsb, session.json) and history sync.
import { win32 } from 'node:path';

/** Guest folders no mapping may use: the OS, the sandbox's own folders and the mirror root. */
export const RESERVED_GUEST = /^C:\\(?:Windows|Program Files|Program Files \(x86\)|ProgramData|Users|AgentLaunch|AgentData|HostTools|nvm|Mirror)(?:\\|$)/i;
/** Where folders for other drive letters really live inside the sandbox: C:\Mirror\<letter>. */
export const MIRROR_ROOT = 'C:\\Mirror';
/** Letters a mirrored path may use. Never C: (the sandbox's own disk); A:/B: are left alone (floppy-era tools). */
export const MIRROR_LETTER = /^[D-Z]$/;

const DRIVE_PATH = /^([A-Za-z]):\\(.*)$/;
// No other ':' (alternate data streams), no wildcards or pipes, no control characters, no forward slashes.
const BAD_CHARS = /[<>:"|?*/\x00-\x1f]/;

/** The upper-case drive letter of an absolute guest path (F:\x -> F), or null. */
export const guestDrive = (guest: string): string | null => DRIVE_PATH.exec(guest)?.[1].toUpperCase() ?? null;

/**
 * A folder the sandbox can show a host folder at: C:\<not reserved>\... or <D-Z>:\..., never a drive root,
 * no '..' or empty segments, no characters Windows rejects in paths.
 */
export const isValidGuestPath = (guest: string): boolean => {
  const m = DRIVE_PATH.exec(guest);
  if (!m) return false;
  const letter = m[1].toUpperCase();
  const rest = m[2].replace(/\\+$/, '');
  if (rest === '' || BAD_CHARS.test(rest)) return false;
  if (rest.split('\\').some((segment) => segment === '' || segment === '.' || segment === '..' || /[. ]$/.test(segment))) return false;
  if (letter === 'C') return !RESERVED_GUEST.test('C:\\' + rest);
  return MIRROR_LETTER.test(letter);
};

/** Where a mapping lands when the path it asks for (or the PC path) cannot be used inside the sandbox. */
export const MAPPED_ROOT = 'C:\\Mapped';

/** A guest path as typed, tidied: '/' -> '\', no doubled or trailing backslashes, upper-case drive letter. */
export const tidyGuestPath = (guest: string): string => {
  const p = guest.trim().replace(/\//g, '\\').replace(/\\{2,}/g, '\\').replace(/\\+$/, '');
  return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
};

/** Why a guest path cannot be used as it is (null: it can). Short, plain English. */
export const guestPathProblem = (guest: string): string | null => {
  if (isValidGuestPath(guest)) return null;
  const letter = guestDrive(guest);
  if (letter === 'C' && RESERVED_GUEST.test(guest)) return guest + ' is a folder the sandbox keeps for itself (Windows, Program Files, Users, AgentData, ...)';
  if (letter && !MIRROR_LETTER.test(letter) && letter !== 'C') return 'the sandbox cannot show drive ' + letter + ':';
  if (letter && /^[A-Za-z]:\\?$/.test(guest)) return guest + ' is a whole drive';
  return guest + ' is not a folder path the sandbox can use';
};

/** C:\Mapped\<drive>\<rest of path>: a safe place for a folder whose own path cannot be used (odd characters made safe). */
export const mappedFallback = (path: string): string => {
  const m = /^([A-Za-z]):\\?(.*)$/.exec(tidyGuestPath(path)) ?? /^\\\\(.*)$/.exec(path);
  const letter = m && m.length === 3 ? m[1].toUpperCase() : 'UNC';
  const rest = (m ? m[m.length - 1] : path).split(/[\\/]+/).map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '')).filter((s) => s !== '' && s !== '..').join('\\');
  return MAPPED_ROOT + '\\' + letter + (rest ? '\\' + rest : '');
};

/** Two guest folders overlap where they really are (F:\x is C:\Mirror\F\x): the same, or one inside the other. */
export const guestOverlaps = (a: string, b: string): boolean => {
  const x = sandboxFolder(a).replace(/\\+$/, '').toLowerCase();
  const y = sandboxFolder(b).replace(/\\+$/, '').toLowerCase();
  return x === y || x.startsWith(y + '\\') || y.startsWith(x + '\\');
};

/**
 * Where an extra folder appears in the sandbox. `wanted` is the guest path asked for (or the one derived from the PC
 * path); when the sandbox cannot use it (reserved, invalid, or overlapping a folder in `taken`), the folder goes to
 * C:\Mapped\<drive>\<path> instead (made unique with -2, -3 ...), and `note` says where and why.
 */
export const placeGuest = (host: string, wanted: string, taken: { guest: string; what: string }[]): { guest: string; note: string | null } => {
  const clash = (g: string) => taken.find((t) => guestOverlaps(g, t.guest));
  const tidy = tidyGuestPath(wanted);
  const problem = guestPathProblem(tidy);
  const other = problem ? null : clash(tidy);
  if (!problem && !other) return { guest: tidy, note: null };
  const why = problem ?? tidy + ' is already used by ' + other!.what + (other!.guest.toLowerCase() === tidy.toLowerCase() ? '' : ' (' + other!.guest + ')');
  const guest = freePlace(mappedFallback(/^[A-Za-z]:/.test(tidy) ? tidy : host), clash);
  return { guest, note: host + ': ' + why + ', so it is at ' + guest + ' in the sandbox.' };
};

/**
 * The guest path a mapping asks for when it gives none: a folder inside the project at the same place in the project's
 * guest folder, any other folder at the same path as on this PC (D: to Z: through C:\Mirror and subst).
 */
export const deriveGuest = (host: string, projectHost: string, projectGuest: string): string => {
  const rel = win32.relative(win32.resolve(projectHost), win32.resolve(host));
  const inside = rel === '' || (!rel.startsWith('..') && !win32.isAbsolute(rel));
  return inside ? (rel ? win32.join(projectGuest, rel) : projectGuest) : tidyGuestPath(win32.resolve(host));
};

const freePlace =(base: string, clash: (g: string) => unknown): string => {
  const ok = (g: string) => isValidGuestPath(g) && !clash(g);
  if (ok(base)) return base;
  for (let i = 2; i < 1000; i++) if (ok(base + '-' + i)) return base + '-' + i;
  return base + '-' + Date.now();
};

/** Where a guest path really is inside the sandbox (the .wsb SandboxFolder): C: paths as-is, F:\x -> C:\Mirror\F\x. */
export const sandboxFolder = (guest: string): string => {
  const m = DRIVE_PATH.exec(guest);
  if (!m || m[1].toUpperCase() === 'C') return guest;
  return MIRROR_ROOT + '\\' + m[1].toUpperCase() + (m[2] ? '\\' + m[2] : '');
};

export interface SubstDrive { letter: string; target: string }

/** The subst drives the guest must create at boot for these guest paths, one per letter, sorted. */
export const substDrives = (guests: string[]): SubstDrive[] => {
  const letters = [...new Set(guests.map(guestDrive).filter((l): l is string => l !== null && l !== 'C'))].sort();
  return letters.map((letter) => ({ letter, target: MIRROR_ROOT + '\\' + letter }));
};

/**
 * guestWorkspace "mirror": the workspace at the same path as on this PC, so absolute paths (configs, build caches,
 * cargo fingerprints, Claude's project folder) match. Falls back to `fallback` (C:\Workspace\<name>) when the host
 * path cannot be used inside the sandbox (C:\Users\..., a UNC path, A:/B:, odd characters), with a note saying why.
 */
export const planMirrorWorkspace = (workspaceHost: string, fallback: string): { guest: string; note: string | null } => {
  const host = workspaceHost.replace(/\\+$/, '');
  if (isValidGuestPath(host)) {
    const letter = guestDrive(host);
    return { guest: letter + host.slice(1), note: letter === 'C' ? null : 'guestWorkspace "mirror": ' + host + ' is mapped to ' + sandboxFolder(letter + host.slice(1)) + ' and shown as ' + letter + ': (subst) inside the sandbox.' };
  }
  const why = !guestDrive(host) ? 'it is not on a drive letter'
    : guestDrive(host) === 'C' && RESERVED_GUEST.test(host) ? 'that folder is reserved inside the sandbox (Windows, Program Files, Users, ...)'
    : 'the sandbox cannot show a folder at that path';
  return { guest: fallback, note: 'guestWorkspace "mirror": ' + host + ' cannot appear at the same path (' + why + '); using ' + fallback + ' instead.' };
};
