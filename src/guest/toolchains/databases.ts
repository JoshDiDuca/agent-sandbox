// Databases inside the sandbox: PostgreSQL, MariaDB (MySQL-compatible), MongoDB and Redis. Binaries live in
// C:\AgentData\tools, data in C:\AgentData\databases (both persist), and every server listens on localhost only.
// Which ones run was decided on the host (session.databases): only what the project needs.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { DatabasePlan } from '../../core/types.js';
import { fetchJson, fetchText, githubAsset, installArchive } from '../../shared/download.js';
import { SYSTEM } from '../../shared/system.js';
import { ensureJdk } from './java.js';
import { dataDir, dryRun, execAsync, exists, log, logsDir, mkdirp } from '../env.js';
import { resolveCached, tool, type ToolEnv } from './common.js';

const dataFor = (name: string): string => path.join(dataDir, 'databases', name);

export const portOpen = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

const waitForPort = async (port: number, seconds: number): Promise<boolean> => {
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

/** Starts a server detached (it outlives the boot script) with its output in logs\<name>.log, and waits for its port. */
const startServer = async (name: string, exe: string, args: string[], port: number): Promise<void> => {
  if (await portOpen(port)) throw new Error('port ' + port + ' is already in use (change databases.' + name + '.port)');
  const logFile = path.join(logsDir, name + '.log');
  const out = fs.openSync(logFile, 'a');
  spawn(exe, args, { detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
  fs.closeSync(out);
  if (!(await waitForPort(port, 60))) throw new Error(name + ' did not start listening on port ' + port + '; see ' + logFile);
};

/** Lock files a sandbox that was closed without shutting the server down leaves behind (this VM never ran it). */
const clearStaleLocks = (dir: string, files: string[]): void => { for (const f of files) fs.rmSync(path.join(dir, f), { force: true }); };

// ---- PostgreSQL (EnterpriseDB's Windows binaries, without pgAdmin) --------------------------------------------------

interface PgVersion { major: string; latestMinor: string; supported: boolean; current: boolean }

const setupPostgres = async (env: ToolEnv, plan: DatabasePlan): Promise<void> => {
  const exact = await resolveCached('postgres:' + plan.version, async () => {
    const versions = (await fetchJson<PgVersion[]>('https://www.postgresql.org/versions.json')).filter((v) => v.supported);
    const hit = plan.version === 'latest' ? versions.find((v) => v.current) ?? versions[versions.length - 1] : versions.find((v) => v.major === plan.version.split('.')[0]);
    return hit ? hit.major + '.' + hit.latestMinor : Promise.reject(new Error('No supported PostgreSQL ' + plan.version));
  });
  const home = tool('postgres', exact);
  const bin = path.join(home, 'bin');
  if (!exists(path.join(bin, 'pg_ctl.exe'))) {
    log('Downloading PostgreSQL ' + exact + ' (~330 MB once) ...');
    // EDB publishes no checksums; the download is HTTPS from EnterpriseDB, PostgreSQL's official Windows packager.
    await installArchive('https://get.enterprisedb.com/postgresql/postgresql-' + exact + '-1-windows-x64-binaries.zip', home, { locate: 'pg_ctl.exe', up: 1, fileName: 'postgresql-' + exact + '.zip', members: ['pgsql/bin', 'pgsql/lib', 'pgsql/share', 'pgsql/include'] });
  }
  const data = dataFor('postgres-' + exact.split('.')[0]);
  if (!exists(path.join(data, 'PG_VERSION'))) {
    log('Creating the PostgreSQL database cluster ...');
    mkdirp(path.dirname(data));
    await execAsync(path.join(bin, 'initdb.exe'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C'], { stdio: 'ignore' });
  }
  clearStaleLocks(data, ['postmaster.pid']);
  // postgres.exe refuses to run as an administrator (the sandbox user is one); pg_ctl drops the rights first.
  if (await portOpen(plan.port)) throw new Error('port ' + plan.port + ' is already in use (change databases.postgres.port)');
  await execAsync(path.join(bin, 'pg_ctl.exe'), ['start', '-D', data, '-w', '-t', '60', '-l', path.join(logsDir, 'postgres.log'), '-o', '-p ' + plan.port + ' -c listen_addresses=localhost'], { stdio: 'ignore' });
  Object.assign(env.vars, { PGHOST: 'localhost', PGPORT: String(plan.port), PGUSER: 'postgres' });
  env.prepend.push(bin);
  env.summary.push('postgres ' + exact + ': localhost:' + plan.port + ', user postgres, no password (postgres://postgres@localhost:' + plan.port + '/postgres)');
};

// ---- MariaDB (MySQL-compatible) ---------------------------------------------------------------------------------

interface MariaRelease { release_id: string; release_status: string; release_support_type: string | null }
interface MariaFiles { releases: Record<string, { files: { file_name: string; file_download_url: string; checksum?: { sha256sum?: string } }[] }> }
const MARIA = 'https://downloads.mariadb.org/rest-api/mariadb/';

const setupMysql = async (env: ToolEnv, plan: DatabasePlan): Promise<void> => {
  const series = await resolveCached('mariadb:' + plan.version, async () => {
    if (plan.version !== 'lts') return plan.version;
    const { major_releases: all } = await fetchJson<{ major_releases: MariaRelease[] }>(MARIA);
    return all.find((r) => r.release_status === 'Stable' && r.release_support_type === 'Long Term Support')?.release_id ?? Promise.reject(new Error('No MariaDB LTS release found'));
  });
  const latest = async () => {
    const { releases } = await fetchJson<MariaFiles>(MARIA + series + '/latest/');
    const [version, release] = Object.entries(releases)[0] ?? [];
    const zip = release?.files.find((f) => /-winx64\.zip$/.test(f.file_name));
    return zip ? { version, zip } : Promise.reject(new Error('No MariaDB ' + series + ' zip for Windows'));
  };
  const version = await resolveCached('mariadb-version:' + series, async () => (await latest()).version);
  const home = tool('mariadb', version);
  const bin = path.join(home, 'bin');
  if (!exists(path.join(bin, 'mariadbd.exe'))) {
    const { zip } = await latest();
    log('Downloading MariaDB ' + version + ' ...');
    await installArchive(zip.file_download_url.replace(/^http:/, 'https:'), home, { sha256: zip.checksum?.sha256sum ?? null, locate: 'mariadbd.exe', up: 1, fileName: zip.file_name });
  }
  const data = dataFor('mariadb');
  if (!exists(path.join(data, 'mysql'))) {
    log('Creating the MariaDB data folder ...');
    mkdirp(path.dirname(data));
    await execAsync(path.join(bin, 'mariadb-install-db.exe'), ['--datadir=' + data, '--port=' + plan.port], { stdio: 'ignore' });
  }
  await startServer('mysql', path.join(bin, 'mariadbd.exe'), ['--datadir=' + data, '--port=' + plan.port, '--bind-address=127.0.0.1', '--console'], plan.port);
  Object.assign(env.vars, { MYSQL_HOST: '127.0.0.1', MYSQL_TCP_PORT: String(plan.port) });
  env.prepend.push(bin);
  env.summary.push('mysql (MariaDB ' + version + '): 127.0.0.1:' + plan.port + ', user root, no password (mysql://root@127.0.0.1:' + plan.port + ')');
};

// ---- MongoDB -----------------------------------------------------------------------------------------------------

interface MongoVersions { versions: { version: string; production_release: boolean; downloads: { target: string; arch: string; edition: string; archive: { url: string; sha256: string } }[] }[] }

const setupMongo = async (env: ToolEnv, plan: DatabasePlan): Promise<void> => {
  const find = async () => {
    const { versions } = await fetchJson<MongoVersions>('https://downloads.mongodb.org/full.json');
    const prod = versions.filter((v) => v.production_release);
    const hit = plan.version === 'latest' ? prod[0] : prod.find((v) => v.version === plan.version || v.version.startsWith(plan.version + '.'));
    const archive = hit?.downloads.find((d) => d.target === 'windows' && d.arch === 'x86_64' && d.edition === 'base')?.archive;
    return hit && archive ? { version: hit.version, archive } : Promise.reject(new Error('No MongoDB ' + plan.version + ' for Windows'));
  };
  const version = await resolveCached('mongodb:' + plan.version, async () => (await find()).version);
  const home = tool('mongodb', version);
  if (!exists(path.join(home, 'bin', 'mongod.exe'))) {
    const { archive } = await find();
    log('Downloading MongoDB ' + version + ' ...');
    await installArchive(archive.url, home, { sha256: archive.sha256, locate: 'mongod.exe', up: 1 });
  }
  const shell = tool('mongosh');
  if (!exists(path.join(shell, 'mongosh.exe'))) {
    const asset = await githubAsset('mongodb-js/mongosh', /^mongosh-[\d.]+-win32-x64\.zip$/);
    log('Downloading mongosh ...');
    await installArchive(asset.url, shell, { sha256: asset.sha256, locate: 'mongosh.exe', fileName: asset.name });
  }
  const data = mkdirp(dataFor('mongodb'));
  clearStaleLocks(data, ['mongod.lock']);
  await startServer('mongodb', path.join(home, 'bin', 'mongod.exe'), ['--dbpath', data, '--bind_ip', '127.0.0.1', '--port', String(plan.port)], plan.port);
  env.prepend.push(path.join(home, 'bin'), shell);
  env.summary.push('mongodb ' + version + ': mongodb://127.0.0.1:' + plan.port + ' (mongosh on PATH)');
};

// ---- Redis -------------------------------------------------------------------------------------------------------

const setupRedis = async (env: ToolEnv, plan: DatabasePlan): Promise<void> => {
  const home = tool('redis');
  if (!exists(path.join(home, 'redis-server.exe'))) {
    // Redis has no official Windows build; this is the maintained community build of upstream Redis (MSYS2).
    const asset = await githubAsset('redis-windows/redis-windows', /^Redis-[\d.]+-Windows-x64-msys2\.zip$/);
    log('Downloading ' + asset.name + ' ...');
    await installArchive(asset.url, home, { sha256: asset.sha256, locate: 'redis-server.exe', fileName: asset.name });
  }
  const data = mkdirp(dataFor('redis'));
  await startServer('redis', path.join(home, 'redis-server.exe'), ['--port', String(plan.port), '--bind', '127.0.0.1', '--dir', data.replace(/\\/g, '/'), '--appendonly', 'yes'], plan.port);
  env.prepend.push(home);
  env.summary.push('redis: redis://127.0.0.1:' + plan.port + ' (redis-cli on PATH)');
};

// ---- DynamoDB Local + dynamodb-admin -------------------------------------------------------------------------------

const DYNAMO_ZIP = 'https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.zip';

/**
 * Amazon's DynamoDB Local (a Java program; the Java toolchain step runs first, else this installs the LTS JDK) and
 * dynamodb-admin, the web UI to browse and edit tables, installed with the runner's own npm. Every AWS SDK picks the
 * local endpoint up from AWS_ENDPOINT_URL_DYNAMODB, with dummy credentials (real ones never reach the sandbox).
 */
const setupDynamo = async (env: ToolEnv, plan: DatabasePlan): Promise<void> => {
  const java = path.join(await ensureJdk(), 'bin', 'java.exe');
  const home = tool('dynamodb-local');
  if (!exists(path.join(home, 'DynamoDBLocal.jar'))) {
    log('Downloading DynamoDB Local ...');
    const sha256 = (await fetchText(DYNAMO_ZIP + '.sha256')).trim().split(/\s+/)[0];
    await installArchive(DYNAMO_ZIP, home, { sha256, locate: 'DynamoDBLocal.jar', fileName: 'dynamodb_local.zip' });
  }
  const data = mkdirp(dataFor('dynamodb'));
  // -sharedDb: one database whatever region/credentials a client uses, so the admin UI and the app see the same tables.
  await startServer('dynamodb', java, ['-Djava.library.path=' + path.join(home, 'DynamoDBLocal_lib'), '-jar', path.join(home, 'DynamoDBLocal.jar'), '-sharedDb', '-dbPath', data, '-port', String(plan.port)], plan.port);
  const endpoint = 'http://localhost:' + plan.port;
  const aws = { AWS_ENDPOINT_URL_DYNAMODB: endpoint, DYNAMO_ENDPOINT: endpoint, AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local', AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' };
  Object.assign(env.vars, aws);
  env.summary.push('dynamodb (DynamoDB Local): ' + endpoint + ' (AWS SDKs use it automatically via AWS_ENDPOINT_URL_DYNAMODB; dummy credentials)');
  if (!plan.adminPort) return;
  const prefix = tool('dynamodb-admin');
  const script = path.join(prefix, 'node_modules', 'dynamodb-admin', 'dist', 'dynamodb-admin.js');
  if (!exists(script)) {
    log('Installing dynamodb-admin (web UI for DynamoDB) ...');
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await execAsync(process.execPath, [npmCli, 'install', '--global', '--prefix', prefix, 'dynamodb-admin', '--no-fund', '--no-audit'], { stdio: 'ignore' });
  }
  const admin = { ...process.env, ...aws, DYNAMO_ENDPOINT: endpoint };
  // The database matters more than its UI: a taken port is reported, not fatal.
  if (await portOpen(plan.adminPort)) { env.summary.push('dynamodb-admin: NOT started, port ' + plan.adminPort + ' is in use (change databases.dynamodb.adminPort)'); return; }
  const out = fs.openSync(path.join(logsDir, 'dynamodb-admin.log'), 'a');
  spawn(process.execPath, [script, '--port', String(plan.adminPort), '--dynamo-endpoint', endpoint, '--skip-default-credentials'], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: admin }).unref();
  fs.closeSync(out);
  if (!(await waitForPort(plan.adminPort, 30))) throw new Error('dynamodb-admin did not start; see ' + path.join(logsDir, 'dynamodb-admin.log'));
  env.summary.push('dynamodb-admin: http://localhost:' + plan.adminPort + ' (browse and edit tables in the sandbox\'s browser)');
};

const SETUP = { postgres: setupPostgres, mysql: setupMysql, mongodb: setupMongo, redis: setupRedis, dynamodb: setupDynamo } as const;

export const DATABASE_NAMES: Record<DatabasePlan['database'], string> = { postgres: 'PostgreSQL', mysql: 'MySQL (MariaDB)', mongodb: 'MongoDB', redis: 'Redis', dynamodb: 'DynamoDB Local', sqlserver: 'SQL Server' };

/** The process listening on a local TCP port (netstat: no PowerShell start-up cost), or null. */
const listenerPid = (port: number): number | null => {
  const out = spawnSync(SYSTEM.netstat(), ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  const hit = out.split(/\r?\n/).map((l) => /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(l)).find((m) => m && Number(m[1]) === port);
  return hit ? Number(hit[2]) : null;
};

/** Stops a database (and DynamoDB's admin UI). PostgreSQL shuts down cleanly through pg_ctl; the others are ended. */
export const stopDatabase = async (plan: DatabasePlan): Promise<boolean> => {
  if (!(await portOpen(plan.port))) return false;
  if (plan.database === 'postgres' && exists(tool('postgres'))) {
    for (const version of fs.readdirSync(tool('postgres'))) {
      const data = dataFor('postgres-' + version.split('.')[0]);
      const pgCtl = path.join(tool('postgres', version), 'bin', 'pg_ctl.exe');
      if (exists(path.join(data, 'postmaster.pid')) && exists(pgCtl)) await execAsync(pgCtl, ['stop', '-D', data, '-m', 'fast', '-w'], { stdio: 'ignore' });
    }
  }
  for (const port of [plan.port, plan.adminPort ?? 0]) {
    const pid = port && listenerPid(port);
    if (pid) try { process.kill(pid); } catch { /* already gone */ }
  }
  return true;
};

export const setupDatabase = async (env: ToolEnv, plan: DatabasePlan): Promise<void> => {
  if (plan.database === 'sqlserver') {
    env.summary.push('sqlserver: NOT available (SQL Server cannot start inside Windows Sandbox). Use the one on the PC via hostAccess.forwards, or switch the project to Postgres/SQLite for local work');
    return;
  }
  if (dryRun) { log('(dry run) would run ' + DATABASE_NAMES[plan.database] + ' on port ' + plan.port + ' (' + plan.reasons.join('; ') + ')'); return; }
  await SETUP[plan.database](env, plan);
};

