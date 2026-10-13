// Databases inside the sandbox: PostgreSQL, MariaDB (MySQL-compatible), MongoDB, Redis and DynamoDB Local. Binaries
// live in C:\AgentData\tools, data in C:\AgentData\databases (both persist), and every server listens on localhost
// only. Which ones run was decided on the host (session.databases): only what the project needs.
import type { DatabasePlan } from '../../core/types.js';
import { dryRun } from '../runtime/paths.js';
import { log } from '../runtime/log.js';
import { portOpen } from '../runtime/ports.js';
import { duringSession } from '../runtime/project-context.js';
import type { ToolEnv } from '../toolchains/tool-env.js';
import { killListeners, type DatabaseServer } from './database-server.js';
import { DynamoServer } from './dynamodb.js';
import { MongoServer } from './mongodb.js';
import { MysqlServer } from './mysql.js';
import { DATABASE_NAMES, type ServedDatabase } from './names.js';
import { PostgresServer } from './postgres.js';
import { RedisServer } from './redis.js';

const SERVERS = {
  postgres: new PostgresServer(),
  mysql: new MysqlServer(),
  mongodb: new MongoServer(),
  redis: new RedisServer(),
  dynamodb: new DynamoServer(),
} as const satisfies Record<ServedDatabase, DatabaseServer>;

/** Stops a database (and DynamoDB's admin UI); false when it was not running. */
export async function stopDatabase(plan: DatabasePlan): Promise<boolean> {
  if (!(await portOpen(plan.port))) return false;
  // SQL Server never runs here: whatever listens on its port is just ended.
  if (plan.database === 'sqlserver') killListeners(plan);
  else await SERVERS[plan.database].stop(plan);
  return true;
}

export async function setupDatabase(env: ToolEnv, plan: DatabasePlan): Promise<void> {
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
  await SERVERS[plan.database].start(env, plan);
}
