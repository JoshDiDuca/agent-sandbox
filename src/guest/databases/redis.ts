// Redis (the maintained community Windows build of upstream Redis).
import path from 'node:path';
import type { DatabasePlan } from '../../core/types.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { installFromGithub } from '../toolchains/install.js';
import { tool, type ToolEnv } from '../toolchains/tool-env.js';
import { dataFor, startServer } from './server.js';

export const setupRedis = async (env: ToolEnv, plan: DatabasePlan): Promise<void> => {
  const home = tool('redis');
  if (!exists(path.join(home, 'redis-server.exe'))) {
    // Redis has no official Windows build; this one is built from upstream Redis with MSYS2.
    await installFromGithub('redis-windows/redis-windows', /^Redis-[\d.]+-Windows-x64-msys2\.zip$/, {
      dest: home,
      what: (a) => 'Redis (' + a.name + ', ~10 MB once)',
      locate: 'redis-server.exe',
    });
  }
  const data = mkdirp(dataFor('redis'));
  await startServer(
    'redis',
    path.join(home, 'redis-server.exe'),
    ['--port', String(plan.port), '--bind', '127.0.0.1', '--dir', data.replace(/\\/g, '/'), '--appendonly', 'yes'],
    plan.port,
  );
  env.prepend.push(home);
  env.summary.push('redis: redis://127.0.0.1:' + plan.port + ' (redis-cli on PATH)');
};
