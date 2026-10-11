// Reads a project the way detect-databases.ts needs it (only manifest/config/compose files, bounded), and looks at which
// database services this PC has, so `enabled: "auto"` databases are installed only for projects that use them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Config, DatabasePlan } from '../core/types.js';
import { DATABASES, databasesFromServices, detectDatabases, INTERESTING_FILE, type Database, type ProjectFile } from '../core/detect-databases.js';
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
  const detected = autos.length ? detectDatabases(files, probe.host ?? hostDatabases()) : [];
  const compose = files.filter((f) => /compose/i.test(f.path));
  const versions: Record<Database, string> = {
    postgres: pinnedVersion(compose, /image:\s*["']?(?:[\w.-]+\/)*postgres:([\w.-]+)/i) ?? (config.postgres.version === 'latest' ? 'latest' : config.postgres.version),
    mysql: config.mysql.version,
    mongodb: pinnedVersion(compose, /image:\s*["']?(?:[\w.-]+\/)*mongo:([\w.-]+)/i) ?? config.mongodb.version,
    redis: 'latest',
    dynamodb: 'latest',
    sqlserver: '',
  };
  const ports: Record<Database, number> = { postgres: config.postgres.port, mysql: config.mysql.port, mongodb: config.mongodb.port, redis: config.redis.port, dynamodb: config.dynamodb.port, sqlserver: 1433 };
  return DATABASES.flatMap((database): DatabasePlan[] => {
    const setting = config[database].enabled;
    const found = detected.find((d) => d.database === database);
    const extra = database === 'dynamodb' && config.dynamodb.admin ? { adminPort: config.dynamodb.adminPort } : {};
    if (setting === true) return [{ database, reasons: ['enabled in config'], version: versions[database], port: ports[database], ...extra }];
    if (setting === 'auto' && found) return [{ database, reasons: found.reasons, version: versions[database], port: ports[database], ...extra }];
    return [];
  });
};
