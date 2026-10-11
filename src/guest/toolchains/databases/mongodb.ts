// MongoDB Community, with mongosh.
import path from 'node:path';
import type { DatabasePlan } from '../../../core/types.js';
import { fetchJson, installArchive } from '../../../shared/download.js';
import { exists, log, mkdirp } from '../../env.js';
import { installFromGithub, resolveCached, tool, type ToolEnv } from '../common.js';
import { clearStaleLocks, dataFor, startServer } from './server.js';

interface MongoVersions { versions: { version: string; production_release: boolean; downloads: { target: string; arch: string; edition: string; archive: { url: string; sha256: string } }[] }[] }

export const setupMongo = async (env: ToolEnv, plan: DatabasePlan): Promise<void> => {
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
    log('Downloading MongoDB ' + version + ' (~400 MB once) ...');
    await installArchive(archive.url, home, { sha256: archive.sha256, locate: 'mongod.exe', up: 1 });
  }
  const shell = tool('mongosh');
  if (!exists(path.join(shell, 'mongosh.exe'))) {
    await installFromGithub('mongodb-js/mongosh', /^mongosh-[\d.]+-win32-x64\.zip$/, { dest: shell, what: 'mongosh, the MongoDB shell (~50 MB once)', locate: 'mongosh.exe' });
  }
  const data = mkdirp(dataFor('mongodb'));
  await clearStaleLocks(data, ['mongod.lock'], plan.port);
  await startServer('mongodb', path.join(home, 'bin', 'mongod.exe'), ['--dbpath', data, '--bind_ip', '127.0.0.1', '--port', String(plan.port)], plan.port);
  env.prepend.push(path.join(home, 'bin'), shell);
  env.summary.push('mongodb ' + version + ': mongodb://127.0.0.1:' + plan.port + ' (mongosh on PATH)');
};
