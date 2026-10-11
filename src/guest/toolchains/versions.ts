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

/** Newest stable version matching a prefix spec ("3" -> 3.13.1, "3.12" -> 3.12.10). */
export const pickPackageVersion = (all: string[], spec: string): string | null => {
  const s = spec.trim().replace(/^python-?/i, '');
  const stable = all.filter((v) => /^\d+(\.\d+)*$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return stable.find((v) => v === s || v.startsWith(s + '.')) ?? null;
};
