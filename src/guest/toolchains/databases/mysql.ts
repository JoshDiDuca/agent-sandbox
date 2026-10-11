// MariaDB, the MySQL-compatible server.
import path from 'node:path';
import type { DatabasePlan } from '../../../core/types.js';
import { fetchJson, installArchive } from '../../../shared/download.js';
import { execAsync, exists, log } from '../../env.js';
import { resolveCached, tool, type ToolEnv } from '../common.js';
import { createOnce, dataFor, startServer } from './server.js';

interface MariaRelease { release_id: string; release_status: string; release_support_type: string | null }
interface MariaFiles { releases: Record<string, { files: { file_name: string; file_download_url: string; checksum?: { sha256sum?: string } }[] }> }
const MARIA = 'https://downloads.mariadb.org/rest-api/mariadb/';

export const setupMysql = async (env: ToolEnv, plan: DatabasePlan): Promise<void> => {
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
    log('Downloading MariaDB ' + version + ' (~90 MB once) ...');
    await installArchive(zip.file_download_url.replace(/^http:/, 'https:'), home, { sha256: zip.checksum?.sha256sum ?? null, locate: 'mariadbd.exe', up: 1, fileName: zip.file_name });
  }
  const data = dataFor('mariadb');
  await createOnce(data, 'mysql', async () => {
    log('Creating the MariaDB database (first start) ...');
    await execAsync(path.join(bin, 'mariadb-install-db.exe'), ['--datadir=' + data, '--port=' + plan.port], { stdio: 'ignore' });
  });
  await startServer('mysql', path.join(bin, 'mariadbd.exe'), ['--datadir=' + data, '--port=' + plan.port, '--bind-address=127.0.0.1', '--console'], plan.port);
  Object.assign(env.vars, { MYSQL_HOST: '127.0.0.1', MYSQL_TCP_PORT: String(plan.port) });
  env.prepend.push(bin);
  env.summary.push('mysql (MariaDB ' + version + '): 127.0.0.1:' + plan.port + ', user root, no password (mysql://root@127.0.0.1:' + plan.port + ')');
};
