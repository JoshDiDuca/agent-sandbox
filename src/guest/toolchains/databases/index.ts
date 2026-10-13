// Databases inside the sandbox: PostgreSQL, MariaDB (MySQL-compatible), MongoDB, Redis and DynamoDB Local. Binaries
// live in C:\AgentData\tools, data in C:\AgentData\databases (both persist), and every server listens on localhost only.
// Which ones run was decided on the host (session.databases): only what the project needs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DatabasePlan } from '../../../core/types.js';
import { SYSTEM } from '../../../shared/system.js';
import { dryRun, execAsync, exists, log } from '../../env.js';
import { tool, type ToolEnv } from '../common.js';
import { setupDynamo } from './dynamodb.js';
import { setupMongo } from './mongodb.js';
import { setupMysql } from './mysql.js';
import { postgresData, setupPostgres } from './postgres.js';
import { setupRedis } from './redis.js';
import { portOpen } from '../../ports.js';
import { duringSession } from '../../project-context.js';

const SETUP = {
  postgres: setupPostgres,
  mysql: setupMysql,
  mongodb: setupMongo,
  redis: setupRedis,
  dynamodb: setupDynamo,
} as const;

export const DATABASE_NAMES: Record<DatabasePlan['database'], string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL (MariaDB)',
  mongodb: 'MongoDB',
  redis: 'Redis',
  dynamodb: 'DynamoDB Local',
  sqlserver: 'SQL Server',
};

/** The process listening on a local TCP port (netstat: no PowerShell start-up cost), or null. */
const listenerPid = (port: number): number | null => {
  const out = spawnSync(SYSTEM.netstat(), ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  const hit = out
    .split(/\r?\n/)
    .map((l) => /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(l))
    .find((m) => m && Number(m[1]) === port);
  return hit ? Number(hit[2]) : null;
};

/** Stops a database (and DynamoDB's admin UI). PostgreSQL shuts down cleanly through pg_ctl; the others are ended. */
export const stopDatabase = async (plan: DatabasePlan): Promise<boolean> => {
  if (!(await portOpen(plan.port))) return false;
  if (plan.database === 'postgres' && exists(tool('postgres'))) {
    for (const version of fs.readdirSync(tool('postgres'))) {
      const data = postgresData(version);
      const pgCtl = path.join(tool('postgres', version), 'bin', 'pg_ctl.exe');
      if (exists(path.join(data, 'postmaster.pid')) && exists(pgCtl))
        await execAsync(pgCtl, ['stop', '-D', data, '-m', 'fast', '-w'], { stdio: 'ignore' });
    }
  }
  for (const port of [plan.port, plan.adminPort ?? 0]) {
    const pid = port && listenerPid(port);
    if (pid)
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
  }
  return true;
};

export const setupDatabase = async (env: ToolEnv, plan: DatabasePlan): Promise<void> => {
  if (plan.database === 'sqlserver') {
    env.summary.push(
      'sqlserver: NOT available (SQL Server cannot start inside Windows Sandbox). Switch the project to Postgres or SQLite for local work',
    );
    return;
  }
  if (dryRun) {
    log(
      '(dry run) would run ' +
        DATABASE_NAMES[plan.database] +
        ' on port ' +
        plan.port +
        ' (' +
        plan.reasons.join('; ') +
        ')',
    );
    return;
  }
  // A project that joined later, while another project's server already listens there: they share it.
  if (duringSession() && (await portOpen(plan.port))) {
    env.summary.push(plan.database + ': shared, already running on port ' + plan.port);
    return;
  }
  await SETUP[plan.database](env, plan);
};
