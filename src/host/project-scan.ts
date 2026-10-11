// Reads a project the way detect-databases.ts needs it (only manifest/config/compose files, bounded), and looks at which
// database services this PC has, so `enabled: "auto"` databases are installed only for projects that use them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Config, DatabasePlan } from '../core/types.js';
import { DATABASES, databasesFromServices, detectDatabases, INTERESTING_FILE, type Database, type ProjectFile } from '../core/detect-databases.js';
import os from 'node:os';
import { AUTO_TOOLCHAINS, type AutoToolchain } from '../core/detect-toolchains.js';
import { pcHasPwsh } from '../core/detect-pwsh.js';
import { isWin } from '../core/util.js';
import { system32 } from '../shared/system.js';

const SKIP = /^(node_modules|\.git|\.hg|\.svn|vendor|target|bin|obj|dist|build|out|\.next|\.nuxt|\.venv|venv|env|__pycache__|\.gradle|\.idea|\.vs|coverage|packages)$/i;
const MAX_FILES = 400;
const MAX_BYTES = 256 * 1024;
const MAX_FOLDERS = 2000;

/** Reads a file through one handle, only if that handle is a regular file of at most MAX_BYTES. */
const readSmallFile = (file: string): string | null => {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    fs.readSync(fd, buffer, 0, stat.size, 0);
    return buffer.toString('utf8');
  } catch { return null; } finally { if (fd !== null) fs.closeSync(fd); }
};

/** Manifest-type files in the project, up to 3 folders deep. Links are not followed (the workspace may be guest-written). */
export const readProjectFiles = (root: string, depth = 3): ProjectFile[] => {
  const files: ProjectFile[] = [];
  let folders = 0;
  const walk = (dir: string, level: number): void => {
    if (++folders > MAX_FOLDERS) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && INTERESTING_FILE.test(entry.name)) {
        const text = readSmallFile(full);
        if (text !== null) files.push({ path: path.relative(root, full), text });
      } else if (entry.isDirectory() && level < depth && !SKIP.test(entry.name)) walk(full, level + 1);
    }
  };
  walk(root, 0);
  return files;
};

/** File names in the project and its direct sub-folders ("api/go.mod"), for toolchain detection. No links followed. */
export const projectEntries = (root: string): string[] => {
  const list = (dir: string): fs.Dirent[] => { try { return fs.readdirSync(dir, { withFileTypes: true }).slice(0, 2000); } catch { return []; } };
  const top = list(root);
  const below = top.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP.test(d.name)).slice(0, 200)
    .flatMap((d) => list(path.join(root, d.name)).filter((f) => f.isFile()).map((f) => d.name + '/' + f.name));
  return [...top.filter((d) => d.isFile()).map((d) => d.name), ...below];
};

/** This PC builds Rust with MSVC: rustup's default host is *-msvc (read from rustup's settings; nothing is run). */
const msvcRust = (): boolean => {
  const settings = path.join(process.env.RUSTUP_HOME ?? path.join(os.homedir(), '.rustup'), 'settings.toml');
  try { return /default_host_triple\s*=\s*"[^"]*-msvc"/.test(fs.readFileSync(settings, 'utf8').slice(0, 64 * 1024)); } catch { return false; }
};

/** Scripts in the project root or one folder down that set up MSVC (vcvars*.bat, vswhere): read with bounded effort. */
export const msvcHint = (root: string): string | undefined => {
  const scripts = projectEntries(root).filter((e) => /\.(ps1|cmd|bat|psm1)$/i.test(e)).slice(0, 60);
  for (const rel of scripts) {
    let text = '';
    try { const file = path.join(root, rel); if (fs.statSync(file).size <= 256 * 1024) text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (/vcvars(all|64|32)?\.bat|vswhere(\.exe)?/i.test(text)) return rel + ' sets up MSVC';
  }
  return undefined;
};

/** Languages this PC has (their commands on PATH; Windows' Store stubs for python do not count). */
export const pcLanguages = (): AutoToolchain[] => {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && !/WindowsApps/i.test(d));
  const has = (...names: string[]): boolean => dirs.some((d) => names.some((n) => fs.existsSync(path.join(d, n))));
  const found: Record<AutoToolchain, boolean> = {
    python: has('python.exe', 'py.exe'), rust: has('cargo.exe', 'rustc.exe'), cpp: has('gcc.exe', 'g++.exe', 'cl.exe', 'clang.exe'),
    msvc: msvcRust(), pwsh: pcHasPwsh(), dotnet: has('dotnet.exe'), go: has('go.exe'), java: has('java.exe', 'javac.exe'), ruby: has('ruby.exe'), php: has('php.exe'), deno: has('deno.exe'),
  };
  return AUTO_TOOLCHAINS.filter((t) => found[t]);
};

/** Database services installed on this PC (names from the service control manager; nothing is started or changed). */
export const hostDatabases = (): Database[] => {
  if (!isWin) return [];
  const result = spawnSync(system32('sc.exe'), ['query', 'type=', 'service', 'state=', 'all'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const names = [...(result.stdout ?? '').matchAll(/^SERVICE_NAME:\s*(.+)$/gm)].map((m) => m[1].trim());
  return databasesFromServices(names);
};

/** The version a compose file pins (postgres:16-alpine -> 16, mongo:7.0 -> 7.0), if any. */
const pinnedVersion = (files: ProjectFile[], image: RegExp): string | null => {
  for (const file of files) {
    const match = image.exec(file.text);
    if (match?.[1] && /^\d+(\.\d+)?/.test(match[1])) return /^\d+(\.\d+)?/.exec(match[1])![0];
  }
  return null;
};

/**
 * What to run in this sandbox: databases set to true, plus "auto" ones the project needs. SQL Server is reported (so
 * the user hears about it) but cannot run inside Windows Sandbox.
 */
export const planDatabases = (config: Config['databases'], workspace: string, probe: { files?: ProjectFile[]; host?: Database[] } = {}): DatabasePlan[] => {
  const autos = DATABASES.filter((db) => config[db].enabled === 'auto');
  const files = autos.length ? probe.files ?? readProjectFiles(workspace) : [];
  const detected = autos.length ? detectDatabases(files, probe.host ?? hostDatabases) : [];
  const plan = databasePlanner(config, files.filter((f) => /compose/i.test(f.path)));
  return DATABASES.flatMap((database): DatabasePlan[] => {
    const setting = config[database].enabled;
    const found = detected.find((d) => d.database === database);
    if (setting === true) return [plan(database, ['enabled in config'])];
    if (setting === 'auto' && found) return [plan(database, found.reasons)];
    return [];
  });
};

/** Every database the sandbox can run, so `sbx-db start <name>` works for ones that did not start at boot. */
export const databaseCatalog = (config: Config['databases']): DatabasePlan[] => {
  const plan = databasePlanner(config, []);
  return DATABASES.filter((db) => db !== 'sqlserver').map((db) => plan(db, ['started with sbx-db']));
};

/** Version (a compose file's image tag wins), port and admin UI for one database. */
const databasePlanner = (config: Config['databases'], compose: ProjectFile[]) => {
  const versions: Record<Database, string> = {
    postgres: pinnedVersion(compose, /image:\s*["']?(?:[\w.-]+\/)*postgres:([\w.-]+)/i) ?? (config.postgres.version === 'latest' ? 'latest' : config.postgres.version),
    mysql: config.mysql.version,
    mongodb: pinnedVersion(compose, /image:\s*["']?(?:[\w.-]+\/)*mongo:([\w.-]+)/i) ?? config.mongodb.version,
    redis: 'latest',
    dynamodb: 'latest',
    sqlserver: '',
  };
  const ports: Record<Database, number> = { postgres: config.postgres.port, mysql: config.mysql.port, mongodb: config.mongodb.port, redis: config.redis.port, dynamodb: config.dynamodb.port, sqlserver: 1433 };
  return (database: Database, reasons: string[]): DatabasePlan => ({
    database, reasons, version: versions[database], port: ports[database],
    ...(database === 'dynamodb' && config.dynamodb.admin ? { adminPort: config.dynamodb.adminPort } : {}),
  });
};
