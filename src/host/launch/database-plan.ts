// Which databases to run in the sandbox: the ones switched on, plus `auto` ones the project needs.
import type { Config, DatabasePlan } from '../../core/types.js';
import { DATABASES, detectDatabases, type Database, type ProjectFile } from '../../core/detect/index.js';
import { hostDatabases } from './pc-scan.js';
import { readProjectFiles } from './project-scan.js';

/** The version a compose file pins (postgres:16-alpine -> 16, mongo:7.0 -> 7.0), if any. */
function pinnedVersion(files: readonly ProjectFile[], image: RegExp): string | null {
  for (const file of files) {
    const match = image.exec(file.text);
    if (match?.[1] && /^\d+(\.\d+)?/.test(match[1])) return /^\d+(\.\d+)?/.exec(match[1])![0];
  }
  return null;
}

/**
 * What to run in this sandbox: databases set to true, plus "auto" ones the project needs. SQL Server is reported (so
 * the user hears about it) but cannot run inside Windows Sandbox.
 */
export function planDatabases(
  config: Config['databases'],
  workspace: string,
  probe: { files?: ProjectFile[]; host?: Database[] } = {},
): DatabasePlan[] {
  const autos = DATABASES.filter((db) => config[db].enabled === 'auto');
  const files = autos.length ? (probe.files ?? readProjectFiles(workspace)) : [];
  const detected = autos.length ? detectDatabases(files, probe.host ?? hostDatabases) : [];
  const plan = databasePlanner(
    config,
    files.filter((f) => /compose/i.test(f.path)),
  );
  return DATABASES.flatMap((database): DatabasePlan[] => {
    const setting = config[database].enabled;
    const found = detected.find((d) => d.database === database);
    if (setting === true) return [plan(database, ['enabled in config'])];
    if (setting === 'auto' && found) return [plan(database, found.reasons)];
    return [];
  });
}

/** Every database the sandbox can run, so `sbx-db start <name>` works for ones that did not start at boot. */
export function databaseCatalog(config: Config['databases']): DatabasePlan[] {
  const plan = databasePlanner(config, []);
  return DATABASES.filter((db) => db !== 'sqlserver').map((db) => plan(db, ['started with sbx-db']));
}

/** Version (a compose file's image tag wins), port and admin UI for one database. */
function databasePlanner(
  config: Config['databases'],
  compose: readonly ProjectFile[],
): (database: Database, reasons: string[]) => DatabasePlan {
  const versions: Record<Database, string> = {
    postgres:
      pinnedVersion(compose, /image:\s*["']?(?:[\w.-]+\/)*postgres:([\w.-]+)/i) ??
      (config.postgres.version === 'latest' ? 'latest' : config.postgres.version),
    mysql: config.mysql.version,
    mongodb: pinnedVersion(compose, /image:\s*["']?(?:[\w.-]+\/)*mongo:([\w.-]+)/i) ?? config.mongodb.version,
    redis: 'latest',
    dynamodb: 'latest',
    sqlserver: '',
  };
  const ports: Record<Database, number> = {
    postgres: config.postgres.port,
    mysql: config.mysql.port,
    mongodb: config.mongodb.port,
    redis: config.redis.port,
    dynamodb: config.dynamodb.port,
    sqlserver: 1433,
  };
  return (database: Database, reasons: string[]): DatabasePlan => ({
    database,
    reasons,
    version: versions[database],
    port: ports[database],
    ...(database === 'dynamodb' && config.dynamodb.admin ? { adminPort: config.dynamodb.adminPort } : {}),
  });
}
