import type { CommandName } from '../manifest.js';
import type { Context } from './context.js';
import { launch } from './launch/index.js';
import { setup } from './setup/index.js';
import { data } from './data/index.js';
import { storage } from './storage/index.js';
import { attach, db, exec, hide, restart, sessions, show, status, stop } from './sessions/index.js';
import { account } from './accounts.js';
import { projects } from './projects/index.js';
import {
  audit,
  claudeHost,
  clean,
  config,
  doctor,
  hostCommand,
  logs,
  migrate,
  sync,
  watcher,
} from './maintenance/index.js';
import { resume } from './resume.js';
import { agentCommandsCommand } from './agent-commands.js';
import { web, webServer } from './web.js';

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
  resume: resume,
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
  migrate: migrate,
  setup: setup,
  data: data,
  storage: storage,
  'host-claude': claudeHost,
  host: hostCommand,
  _watch: watcher,
  web: web,
  _web: webServer,
} satisfies Partial<Record<CommandName, Handler>>;
