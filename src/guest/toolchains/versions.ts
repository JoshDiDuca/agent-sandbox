// Version picking for the toolchains. Pure functions only (no environment, no I/O), so the host and the tests can
// import them without loading the guest runtime.

export interface NodeRelease { version: string; lts: string | false }

/** Turns an .nvmrc-style spec (20, v20.11.1, lts/*, lts/iron, node, latest) into an exact version like 20.11.1. */
export const pickNodeVersion = (releases: NodeRelease[], spec: string): string | null => {
  const s = spec.trim().toLowerCase().replace(/^v/, '');
  const hit = ['node', 'latest', 'current', 'stable'].includes(s) ? releases[0]
    : s === 'lts' || s === 'lts/*' ? releases.find((r) => r.lts)
    : s.startsWith('lts/') ? releases.find((r) => typeof r.lts === 'string' && r.lts.toLowerCase() === s.slice(4))
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
  const picked = want >= pool.length ? pool
    : want === 1 ? [pool[pool.length - 1]]
    : Array.from({ length: want }, (_, i) => pool[Math.round(i * (pool.length - 1) / (want - 1))]);
  return [current, ...picked];
};

/** Newest stable version matching a prefix spec ("3" -> 3.13.1, "3.12" -> 3.12.10). */
export const pickPackageVersion = (all: string[], spec: string): string | null => {
  const s = spec.trim().replace(/^python-?/i, '');
  const stable = all.filter((v) => /^\d+(\.\d+)*$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return stable.find((v) => v === s || v.startsWith(s + '.')) ?? null;
};
