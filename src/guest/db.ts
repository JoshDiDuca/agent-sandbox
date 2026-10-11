// `sbx-db`: list, start and stop the sandbox's databases from a terminal inside it (`sandbox db` on the PC runs it too).
// Usage: sbx-db [list] | sbx-db start <name> | sbx-db stop <name>
import fs from 'node:fs';
import { ProjectSpec } from '../shared/schema.js';
import { portOpen } from './ports.js';
import { DATABASE_NAMES, setupDatabase, stopDatabase } from './toolchains/databases/index.js';
import { emptyEnv } from './toolchains/common.js';
import { addMachineEnvironment } from './setup/environment.js';
import { errMsg, session } from './env.js';
import type { DatabasePlan } from '../core/types.js';

const USAGE = 'Usage: sbx-db [list] | sbx-db start <name> | sbx-db stop <name>';

/** In a project registered after boot (its terminals and exec have AGENT_PROJECT_FILE): that project's database plan. */
const projectPlans = (): DatabasePlan[] | null => {
  const file = process.env.AGENT_PROJECT_FILE;
  if (!file) return null;
  try { return ProjectSpec.safeParse(JSON.parse(fs.readFileSync(file, 'utf8'))).data?.databases ?? null; } catch { return null; }
};

/** The project's own plans first (their versions and ports were chosen for it), then everything else. */
const plans = (): DatabasePlan[] => {
  const boot = projectPlans() ?? session.databases ?? [];
  return [...boot, ...(session.databaseCatalog ?? []).filter((c) => !boot.some((b) => b.database === c.database))];
};

const find = (name: string | undefined): DatabasePlan => {
  const all = plans();
  const plan = all.find((p) => p.database === name?.toLowerCase());
  if (!plan) throw new Error((name ? 'Unknown database "' + name + '". ' : '') + 'Choose one of: ' + all.map((p) => p.database).join(', '));
  if (plan.database === 'sqlserver') throw new Error('SQL Server cannot run inside Windows Sandbox.');
  return plan;
};

const list = async (): Promise<number> => {
  for (const p of plans().filter((x) => x.database !== 'sqlserver')) {
    const state = (await portOpen(p.port)) ? 'running' : 'stopped';
    console.log(p.database.padEnd(10) + state.padEnd(9) + 'port ' + p.port + '  ' + DATABASE_NAMES[p.database]);
  }
  return 0;
};

const start = async (name: string | undefined): Promise<number> => {
  const plan = find(name);
  if (await portOpen(plan.port)) { console.log(plan.database + ' is already running on port ' + plan.port + '.'); return 0; }
  console.log('Starting ' + DATABASE_NAMES[plan.database] + ' (the first time downloads it) ...');
  const env = emptyEnv();
  await setupDatabase(env, plan);
  addMachineEnvironment(env.vars, env.prepend);
  for (const line of env.summary) console.log('  ' + line);
  console.log('New terminal tabs have its variables and tools; this one does not.');
  return 0;
};

const stop = async (name: string | undefined): Promise<number> => {
  const plan = find(name);
  console.log((await stopDatabase(plan)) ? 'Stopped ' + plan.database + '.' : plan.database + ' was not running.');
  return 0;
};

const main = (args: string[]): Promise<number> => {
  const [action = 'list', name] = args;
  if (action === 'list') return list();
  if (action === 'start') return start(name);
  if (action === 'stop') return stop(name);
  console.error(USAGE);
  return Promise.resolve(2);
};

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => { console.error(errMsg(e)); process.exitCode = 1; });
