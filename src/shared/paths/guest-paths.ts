// Guest paths on drive letters other than C:. Windows Sandbox can only map folders onto its own C: drive, so a
// guest path like F:\SteamLibrary\x is mapped to C:\Mirror\F\SteamLibrary\x and, at boot (bootstrap.ps1, before
// anything else uses the workspace), `subst F: C:\Mirror\F` makes it appear at F:\SteamLibrary\x.
// Pure functions only: used by the schema, the host (.wsb, session.json) and history sync.

/** Guest folders no mapping may use: the OS, the sandbox's own folders and the mirror root. */
export const RESERVED_GUEST =
  /^C:\\(?:Windows|Program Files|Program Files \(x86\)|ProgramData|Users|AgentLaunch|AgentData|HostTools|nvm|Mirror)(?:\\|$)/i;
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
  if (
    rest.split('\\').some((segment) => segment === '' || segment === '.' || segment === '..' || /[. ]$/.test(segment))
  )
    return false;
  if (letter === 'C') return !RESERVED_GUEST.test('C:\\' + rest);
  return MIRROR_LETTER.test(letter);
};

/** Where a guest path really is inside the sandbox (the .wsb SandboxFolder): C: paths as-is, F:\x -> C:\Mirror\F\x. */
export const sandboxFolder = (guest: string): string => {
  const m = DRIVE_PATH.exec(guest);
  if (!m || m[1].toUpperCase() === 'C') return guest;
  return MIRROR_ROOT + '\\' + m[1].toUpperCase() + (m[2] ? '\\' + m[2] : '');
};

export interface SubstDrive {
  letter: string;
  target: string;
}

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
export const planMirrorWorkspace = (
  workspaceHost: string,
  fallback: string,
): { guest: string; note: string | null } => {
  const host = workspaceHost.replace(/\\+$/, '');
  if (isValidGuestPath(host)) {
    const letter = guestDrive(host);
    return {
      guest: letter + host.slice(1),
      note:
        letter === 'C'
          ? null
          : 'guestWorkspace "mirror": ' +
            host +
            ' is mapped to ' +
            sandboxFolder(letter + host.slice(1)) +
            ' and shown as ' +
            letter +
            ': (subst) inside the sandbox.',
    };
  }
  const why = !guestDrive(host)
    ? 'it is not on a drive letter'
    : guestDrive(host) === 'C' && RESERVED_GUEST.test(host)
      ? 'that folder is reserved inside the sandbox (Windows, Program Files, Users, ...)'
      : 'the sandbox cannot show a folder at that path';
  return {
    guest: fallback,
    note:
      'guestWorkspace "mirror": ' +
      host +
      ' cannot appear at the same path (' +
      why +
      '); using ' +
      fallback +
      ' instead.',
  };
};
