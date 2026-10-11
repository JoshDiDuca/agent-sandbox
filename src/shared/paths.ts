// Path translation between this PC and the sandbox (shared by the host history sync and the guest plugin fix-up).

/** Claude Code's per-project folder name: every non-alphanumeric character becomes '-'. */
export const projectFolderName = (workspace: string): string => workspace.replace(/[^a-zA-Z0-9]/g, '-');

const jsonEscaped = (p: string): string => JSON.stringify(p).slice(1, -1);
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const forward = (p: string): string => p.replace(/\\/g, '/');

/** Rewrites `from` to `to` wherever it appears as a whole path (raw, JSON-escaped or with forward slashes). */
export const translatePaths = (text: string, from: string, to: string): string => {
  if (from.toLowerCase() === to.toLowerCase()) return text;
  const pairs: [string, string][] = [[jsonEscaped(from), jsonEscaped(to)], [from, to], [forward(from), forward(to)]];
  return pairs.reduce((out: string, [a, b]) => out.replace(new RegExp(escapeRegex(a) + '(?=\\\\|/|"|\'|\\s|$)', 'gi'), b.replace(/\$/g, '$$$$')), text);
};
