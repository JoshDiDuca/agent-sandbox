// The first-start heads-up: what a start downloads once (the tools this project needs) and roughly how much.

/** What a first start downloads, by setting name: its folder in <data>\tools, rough size and a readable name. */
const DOWNLOADS: Readonly<Record<string, { dir: string; mb: number; label?: string }>> = {
  node: { dir: 'nvm', mb: 30 },
  python: { dir: 'python', mb: 30 },
  rust: { dir: 'rust', mb: 300 },
  msvc: { dir: 'msvc', mb: 1500, label: 'MSVC' },
  cpp: { dir: 'mingw', mb: 270, label: 'C/C++' },
  dotnet: { dir: 'dotnet', mb: 250, label: '.NET' },
  go: { dir: 'go', mb: 80 },
  java: { dir: 'java', mb: 200 },
  ruby: { dir: 'ruby', mb: 100 },
  php: { dir: 'php', mb: 30 },
  deno: { dir: 'deno', mb: 40 },
  pwsh: { dir: 'pwsh', mb: 100, label: 'PowerShell 7' },
  vscode: { dir: 'vscode', mb: 150, label: 'VS Code' },
  postgres: { dir: 'postgres', mb: 330, label: 'PostgreSQL' },
  mysql: { dir: 'mariadb', mb: 90, label: 'MariaDB' },
  mongodb: { dir: 'mongodb', mb: 450, label: 'MongoDB' },
  redis: { dir: 'redis', mb: 10 },
  dynamodb: { dir: 'dynamodb-local', mb: 80, label: 'DynamoDB Local' },
};

/** The wanted tools that are not downloaded yet (`has` says whether a folder in <data>\tools exists), with their rough size. */
export function pendingDownloads(
  wanted: readonly string[],
  has: (dir: string) => boolean,
): { names: string[]; mb: number } {
  const missing = [...new Set(wanted)].filter((w) => Object.hasOwn(DOWNLOADS, w) && !has(DOWNLOADS[w].dir));
  return {
    names: missing.map((w) => DOWNLOADS[w].label ?? w),
    mb: missing.reduce((sum, w) => sum + DOWNLOADS[w].mb, 0),
  };
}

function roughSize(mb: number): string {
  return mb >= 950 ? Math.round(mb / 100) / 10 + ' GB' : Math.max(10, Math.round(mb / 10) * 10) + ' MB';
}

/** The heads-up before the wait, or null when everything is already downloaded. first: nothing was ever installed. */
export function firstStartNotice(first: boolean, pending: { names: string[]; mb: number }): string | null {
  if (!first && !pending.names.length) return null;
  const what = pending.names.length
    ? ' (about ' +
      roughSize(pending.mb) +
      ': ' +
      pending.names.slice(0, 8).join(', ') +
      (pending.names.length > 8 ? ', ...' : '') +
      ')'
    : '';
  return first
    ? 'First start: the sandbox downloads the tools this project needs once' +
        what +
        '. This can take 5-20 minutes depending on your connection; later starts take about a minute.'
    : 'New tools for this project: the sandbox downloads them once' +
        what +
        '. This can take a few minutes; later starts skip it.';
}
