import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.js';
import * as commands from './commands.js';
import { LOCAL_CONFIG_NAME } from '../core/local-config.js';
import { selfTest } from '../selftest/index.js';
import { errMsg } from '../core/util.js';

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(packageRoot, 'dist', 'bin', 'agent-sandbox.js');

const USAGE = `agent-sandbox <command> [options] [-- <agent arguments>]

Run it from ANY folder: that folder becomes the sandbox workspace (read/write). Nothing else on this PC is writable.
Shortcuts: claude-sbx / codex-sbx / gemini-sbx [options] [agent args]   sbx-show   claude-host

Sandbox
  launch              start the sandbox and the agent (if a sandbox is running: open another session in it)
  attach [id]         show a running session in THIS terminal with full input (Ctrl+] detaches)
  sessions            list agent sessions          status    sandbox overview
  exec -- <cmd>       run a command inside the sandbox (in the matching workspace folder) and print its output
  restart             restart running agents in place; they resume their conversation
  stop                shut the sandbox down        show / hide   show or hide the sandbox window

Accounts
  account list | save <name> [--from-host] | use <name> [--no-restart] | default <name> | remove <name>

Maintenance
  sync                sync history (and claude-mem, once closed) back to this PC now
  logs [-f]           newest sandbox log           clean [--days n]   prune launches/logs older than n days (auto: 7)
  config show|path|init                            doctor    generate    host-claude    self-test

Options
  --terminal, -t      attach this terminal to the agent (also starts the sandbox when needed)
  --headless          hide the sandbox window (default off; config sandbox.headless)  --window  force it visible
  --account <name>    Claude account to use (default: agent-sandbox account default)
  --node <version>    Node for nvm (default: ${LOCAL_CONFIG_NAME} > .nvmrc/.node-version > this PC's version)
  --python <version>  Python 3 version (default: ${LOCAL_CONFIG_NAME} > .python-version > config)
  --workspace <dir>   use this folder instead of the current one
  --harness <name>    claude | codex | gemini | ...
  --script <file>     run this .ps1/.mjs/.cmd inside the sandbox before the agent (repeatable)
  --no-agent          provision only (no agent)    --trust-config / --no-local-config   ${LOCAL_CONFIG_NAME} handling
  --config <file>     config file (default: ~/.agent-sandbox/config.json)   --json   machine-readable output
  --timeout <s>       exec timeout (default 600)   --personal   (host-claude) use your normal Claude profile`;

type Handler = (ctx: commands.Context) => number | Promise<number | void>;

const HANDLERS: Record<string, Handler> = {
  launch: (ctx) => commands.launch(ctx),
  generate: (ctx) => commands.launch(ctx, true),
  attach: commands.attach,
  sessions: commands.sessions,
  status: commands.status,
  exec: commands.exec,
  restart: commands.restart,
  stop: commands.stop,
  show: commands.show,
  hide: commands.hide,
  account: commands.account,
  sync: commands.sync,
  logs: commands.logs,
  clean: commands.clean,
  config: commands.config,
  doctor: commands.doctor,
  'host-claude': commands.claudeHost,
  _watch: commands.watcher,
};

/** CLI entry. `preset` lets wrapper binaries fix the command/agent (claude-sbx = launch --harness claude). */
export const main = async (argv: string[], preset: { harness?: string; command?: string } = {}): Promise<number> => {
  const options = parseArgs(preset.command ? [preset.command, ...argv] : argv, Boolean(preset.harness));
  if (preset.harness) options.harness = preset.harness;
  if (options.command === 'self-test') return selfTest(packageRoot);
  const handler = HANDLERS[options.command];
  if (!handler) { console.log(USAGE); return ['', 'help', '--help', '-h'].includes(options.command) ? 0 : 1; }
  return (await handler(commands.createContext(packageRoot, entry, options))) ?? 0;
};

export const run = (argv: string[], preset?: { harness?: string; command?: string }): void => {
  main(argv, preset).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => { console.error('\x1b[31mError:\x1b[0m ' + errMsg(e)); process.exitCode = 1; },
  );
};
