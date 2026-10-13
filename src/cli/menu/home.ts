import { type Category } from '../tui/index.js';

/** What a home entry does. */
export type Action =
  | { kind: 'run'; argv: string[] }
  | { kind: 'form'; command: string; preset?: string[] }
  | { kind: 'several' }
  | { kind: 'settings'; target: 'user' | 'project' }
  | { kind: 'apps'; target: 'user' | 'project' };

export const CATEGORIES: Category[] = [
  {
    id: 'start',
    label: 'Start',
    description: 'Start an agent (or several) in a sandbox, or a sandbox with only your tools.',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    description: 'Agent sessions in the running sandbox: show one in this terminal, list them, restart them.',
  },
  {
    id: 'sandbox',
    label: 'Sandbox',
    description: 'The running sandbox: its status, window, databases, projects, and stopping it.',
  },
  {
    id: 'apps',
    label: 'Apps & tools',
    description:
      'Desktop apps and command-line tools for every sandbox: editors, database clients, API clients, game engines, cloud CLIs ... and programs of your own.',
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Every setting, for all projects or just this one, edited in place.',
  },
  { id: 'accounts', label: 'Claude accounts', description: 'Saved Claude logins: save one, switch, set the default.' },
  {
    id: 'data',
    label: 'Data & cleanup',
    description: 'What is kept between sandboxes (tools, databases, logins, logs), and deleting it.',
  },
  { id: 'health', label: 'Health & repair', description: 'Check this PC, find and fix problems, read the logs.' },
];

/** Readable names for commands on the home screen (the manifest's summaries are the descriptions). */
export const TITLES: Record<string, string> = {
  start: 'Start a sandbox without an agent',
  'host-claude': 'Claude on this PC (NOT sandboxed)',
  attach: 'Show a session in this terminal',
  sessions: 'List sessions',
  restart: "Restart this project's agents",
  status: 'Sandbox status',
  db: 'Databases',
  exec: 'Run a command inside',
  stop: 'Stop the sandbox',
  projects: 'Projects',
  show: 'Show the sandbox window',
  hide: 'Hide the sandbox window',
  account: 'Claude accounts',
  data: 'Saved data',
  clean: 'Clean up old files',
  sync: 'Sync history now',
  logs: 'Logs',
  setup: 'Set up this PC',
  doctor: 'Doctor (check this PC)',
  repair: 'Repair',
  'self-test': 'Self-test',
  generate: 'Preview a start (no sandbox)',
  config: 'Config file',
  audit: 'Audit log',
  'agent-commands': 'Agent commands (Beta)',
  launch: 'Start an agent',
};
export const CATEGORY_OF_GROUP: Record<string, string> = {
  Agents: 'start',
  Sandbox: 'sandbox',
  Sessions: 'sessions',
  Accounts: 'accounts',
  Data: 'data',
  Health: 'health',
  Config: 'settings',
};
