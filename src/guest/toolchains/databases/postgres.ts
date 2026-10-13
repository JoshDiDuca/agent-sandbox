// PostgreSQL from EnterpriseDB's Windows binaries (without pgAdmin).
import path from 'node:path';
import type { DatabasePlan } from '../../../core/types.js';
import { fetchJson, installArchive } from '../../../shared/download.js';
import { execAsync, exists, log, logsDir } from '../../env.js';
import { resolveCached, tool, type ToolEnv } from '../common.js';
import { portOpen } from '../../ports.js';
import { clearStaleLocks, createOnce, dataFor } from './server.js';

interface PgVersion {
  major: string;
  latestMinor: string;
  supported: boolean;
  current: boolean;
}

/** The data folder of a PostgreSQL major version (one cluster per major). */
export const postgresData = (version: string): string => dataFor('postgres-' + version.split('.')[0]);

export const setupPostgres = async (env: ToolEnv, plan: DatabasePlan): Promise<void> => {
  const exact = await resolveCached('postgres:' + plan.version, async () => {
    const versions = (await fetchJson<PgVersion[]>('https://www.postgresql.org/versions.json')).filter(
      (v) => v.supported,
    );
    const hit =
      plan.version === 'latest'
        ? (versions.find((v) => v.current) ?? versions[versions.length - 1])
        : versions.find((v) => v.major === plan.version.split('.')[0]);
    return hit
      ? hit.major + '.' + hit.latestMinor
      : Promise.reject(new Error('No supported PostgreSQL ' + plan.version));
  });
  const home = tool('postgres', exact);
  const bin = path.join(home, 'bin');
  if (!exists(path.join(bin, 'pg_ctl.exe'))) {
    log('Downloading PostgreSQL ' + exact + ' (~330 MB once) ...');
    // EDB publishes no checksums; the download is HTTPS from EnterpriseDB, PostgreSQL's official Windows packager.
    await installArchive(
      'https://get.enterprisedb.com/postgresql/postgresql-' + exact + '-1-windows-x64-binaries.zip',
      home,
      {
        locate: 'pg_ctl.exe',
        up: 1,
        fileName: 'postgresql-' + exact + '.zip',
        members: ['pgsql/bin', 'pgsql/lib', 'pgsql/share', 'pgsql/include'],
      },
    );
  }
  const data = postgresData(exact);
  await createOnce(data, 'PG_VERSION', async () => {
    log('Creating the PostgreSQL database (first start) ...');
    await execAsync(
      path.join(bin, 'initdb.exe'),
      ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C'],
      { stdio: 'ignore' },
    );
  });
  if (await portOpen(plan.port))
    throw new Error('port ' + plan.port + ' is already in use (change databases.postgres.port)');
  await clearStaleLocks(data, ['postmaster.pid'], plan.port);
  // postgres.exe refuses to run as an administrator (the sandbox user is one); pg_ctl drops the rights first.
  await execAsync(
    path.join(bin, 'pg_ctl.exe'),
    [
      'start',
      '-D',
      data,
      '-w',
      '-t',
      '60',
      '-l',
      path.join(logsDir, 'postgres.log'),
      '-o',
      '-p ' + plan.port + ' -c listen_addresses=localhost',
    ],
    { stdio: 'ignore' },
  );
  Object.assign(env.vars, { PGHOST: 'localhost', PGPORT: String(plan.port), PGUSER: 'postgres' });
  env.prepend.push(bin);
  env.summary.push(
    'postgres ' +
      exact +
      ': localhost:' +
      plan.port +
      ', user postgres, no password (postgres://postgres@localhost:' +
      plan.port +
      '/postgres)',
  );
};
