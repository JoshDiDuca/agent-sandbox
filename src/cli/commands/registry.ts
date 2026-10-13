import type { CommandName } from '../manifest.js';
import type { Context } from './context.js';
import { launch } from './launch/index.js';
import { setup } from './setup/index.js';
import { data } from './data/index.js';
import { attach, db, exec, hide, restart, sessions, show, status, stop } from './sessions/index.js';
import { account } from './accounts.js';
import { projects } from './projects/index.js';
import { audit, claudeHost, clean, config, doctor, logs, sync, watcher } from './maintenance/index.js';
import { agentCommandsCommand } from './agent-commands.js';

export type Handler = (ctx: Context) => number | Promise<number | void>;

export const HANDLERS: Readonly<Partial<Record<string, Handler>>> = {
  launch: (ctx) => launch(ctx),
  generate: (ctx) => launch(ctx, true),
  attach: attach,
  sessions: sessions,
  status: status,
  exec: exec,
  'agent-commands': agentCommandsCommand,
  db: db,
  restart: restart,
  stop: stop,
  show: show,
  hide: hide,
  account: account,
  projects: projects,
  sync: sync,
  logs: logs,
  audit: audit,
  clean: clean,
  config: config,
  doctor: doctor,
  setup: setup,
  data: data,
  'host-claude': claudeHost,
  _watch: watcher,
} satisfies Partial<Record<CommandName, Handler>>;
