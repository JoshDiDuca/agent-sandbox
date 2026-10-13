// Version picking for the toolchains. Pure functions only (no environment, no I/O), so the host and the tests can
// import them without loading the guest runtime.

export interface NodeRelease {
  version: string;
  lts: string | false;
}

/** Turns an .nvmrc-style spec (20, v20.11.1, lts/*, lts/iron, node, latest) into an exact version like 20.11.1. */
export const pickNodeVersion = (releases: NodeRelease[], spec: string): string | null => {
  const s = spec.trim().toLowerCase().replace(/^v/, '');
  const hit = ['node', 'latest', 'current', 'stable'].includes(s)
    ? releases[0]
    : s === 'lts' || s === 'lts/*'
      ? releases.find((r) => r.lts)
      : s.startsWith('lts/')
        ? releases.find((r) => typeof r.lts === 'string' && r.lts.toLowerCase() === s.slice(4))
        : releases.find((r) => r.version === 'v' + s || r.version.startsWith('v' + s + '.'));
  return hit ? hit.version.slice(1) : null;
};

/**
 * Which of this PC's nvm versions to copy along with `current`: at most `max` in total, current included, the rest
 * spread across the range (newest of each major first, then evenly spaced from oldest to newest).
 */
export const pickSpreadVersions = (available: string[], current: string, max: number): string[] => {
  const byVersion = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const exact = available.filter((v) => /^\d+\.\d+\.\d+$/.test(v) && v !== current).sort(byVersion);
  const newestPerMajor = exact.filter((v, i) => exact[i + 1]?.split('.')[0] !== v.split('.')[0]);
  const pool = newestPerMajor.filter((v) => v.split('.')[0] !== current.split('.')[0]);
  const want = Math.max(0, max - 1);
  const picked =
    want >= pool.length
      ? pool
      : want === 1
        ? [pool[pool.length - 1]]
        : Array.from({ length: want }, (_, i) => pool[Math.round((i * (pool.length - 1)) / (want - 1))]);
  return [current, ...picked];
};

/** Newest stable version matching a prefix spec ("3" -> 3.13.1, "3.12" -> 3.12.10). */
export const pickPackageVersion = (all: string[], spec: string): string | null => {
  const s = spec.trim().replace(/^python-?/i, '');
  const stable = all
    .filter((v) => /^\d+(\.\d+)*$/.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return stable.find((v) => v === s || v.startsWith(s + '.')) ?? null;
};

/** Version spec from a version file's text (.ruby-version "ruby-3.3.1", .java-version "temurin-21", ...): its first x[.y[.z]]. */
export const specFromVersionFile = (text: string): string | null =>
  /(\d+(?:\.\d+){0,2})/.exec(
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, '').trim())
      .find(Boolean) ?? '',
  )?.[1] ?? null;

/** Java major version from .java-version ("21", "17.0.9", "1.8", "temurin-21") or .sdkmanrc ("java=21.0.2-tem"). */
export const javaMajorFrom = (text: string, sdkmanrc = false): string | null => {
  const line = sdkmanrc ? /^\s*java\s*=\s*(.+)$/m.exec(text)?.[1] : text;
  const spec = line ? specFromVersionFile(line) : null;
  if (!spec) return null;
  const [major, minor] = spec.split('.');
  return major === '1' && minor ? minor : major;
};

export interface GoRelease {
  version: string;
  stable: boolean;
  files: { filename: string; os: string; arch: string; kind: string; sha256: string }[];
}

/** "stable" / "latest" -> newest stable release; "1.23" -> newest 1.23.x; "1.23.2" -> exactly that. Returns go.dev's entry. */
export const pickGoRelease = (releases: GoRelease[], spec: string): GoRelease | null => {
  const s = spec.trim().toLowerCase().replace(/^go/, '');
  const stable = releases.filter((r) => r.stable);
  if (s === 'stable' || s === 'latest') return stable[0] ?? null;
  return stable.find((r) => r.version === 'go' + s || r.version.startsWith('go' + s + '.')) ?? null;
};

/**
 * Does the project use a language? `entries` are file names in the workspace root and one folder down ("api/go.mod");
 * markers are exact names or "*.ext".
 */
export const projectUses = (entries: readonly string[], markers: readonly string[]): boolean =>
  entries.some((entry) => {
    const name = entry.split(/[\/]/).pop()!.toLowerCase();
    return markers.some((m) =>
      m.startsWith('*.') ? name.endsWith(m.slice(1).toLowerCase()) : name === m.toLowerCase(),
    );
  });

/** Newest MSVC tools version among VS manifest package ids ("microsoft.vc.14.44.17.14.tools.hostx64.targetx64.base"). */
export const pickMsvcVersion = (packageIds: string[], spec = 'latest'): string | null => {
  const versions = packageIds
    .map((id) => /^microsoft\.vc\.(\d+\.\d+\.\d+\.\d+)\.tools\.hostx64\.targetx64\.base$/i.exec(id)?.[1])
    .filter((v): v is string => Boolean(v));
  const sorted = [...new Set(versions)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return (spec === 'latest' ? sorted[0] : sorted.find((v) => v === spec || v.startsWith(spec + '.'))) ?? null;
};

/** Newest Windows SDK build among component ids ("microsoft.visualstudio.component.windows11sdk.26100"). */
export const pickWindowsSdk = (
  packageIds: string[],
  spec = 'latest',
): { build: string; componentId: string } | null => {
  const found = packageIds
    .map((id) => ({ id, build: /^microsoft\.visualstudio\.component\.windows1[01]sdk\.(\d+)$/i.exec(id)?.[1] }))
    .filter((x): x is { id: string; build: string } => Boolean(x.build));
  const sorted = found.sort((a, b) => Number(b.build) - Number(a.build));
  const hit =
    spec === 'latest' ? sorted[0] : sorted.find((x) => x.build === spec.replace(/^10\.0\./, '').split('.')[0]);
  return hit ? { build: hit.build, componentId: hit.id } : null;
};

/** The .cab files an SDK .msi refers to (their names are inside the msi as plain "<32 hex>.cab"). */
export const msiCabs = (msi: Buffer): string[] => [
  ...new Set([...msi.toString('latin1').matchAll(/([0-9a-f]{32}\.cab)/gi)].map((m) => m[1].toLowerCase())),
];

/** The oldest CMake many projects (OpenMoHAA among them) accept. */
export const CMAKE_FLOOR = '3.25';
export const cmakeTooOld = (version: string): boolean =>
  /^\d+\.\d+/.test(version) && version.localeCompare(CMAKE_FLOOR, undefined, { numeric: true }) < 0;
