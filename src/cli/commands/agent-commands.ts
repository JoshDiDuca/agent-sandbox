// `sandbox agent-commands [status|on|off]` (Beta): typing claude, codex ... on this PC starts them in a hidden sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, userConfigPath } from '../../core/config/index.js';
import type { Config } from '../../core/types.js';
import { fail } from '../../core/util/index.js';
import {
  agentCommands,
  commandsDir,
  reconcileAgentCommands,
  type Reconciled,
} from '../../host/agent-commands/index.js';
import { insideSandbox } from '../../host/sandbox/index.js';
import { writeFileAtomic } from '../../shared/io/index.js';
import { c, table } from '../output/index.js';
import { editConfigText } from '../menu/settings/index.js';
import { type Context } from './context.js';

function entryOf(ctx: Context): string {
  return path.join(ctx.packageRoot, 'dist', 'bin', 'sandbox.js');
}

/** Brings this PC in line with agentCommands and says what changed (used after on/off, settings and launch). */
export function syncAgentCommands(ctx: Context, config: Config, quiet = false): Reconciled | null {
  if (insideSandbox()) return null;
  const result = reconcileAgentCommands(config, ctx.storageRoot, process.execPath, entryOf(ctx));
  if (!result.changed || quiet) return result;
  if (result.on) {
    console.log(
      'Agent commands (Beta) are on for: ' +
        (result.commands.map((a) => a.command).join(', ') || 'no installed agents found'),
    );
    console.log(
      c.dim(
        'Open a new terminal, then type e.g. claude in any project folder. Run the real one: set SANDBOX_AGENT_DIRECT=1',
      ),
    );
  } else console.log('Agent commands are off: claude, codex ... run on this PC again (open a new terminal).');
  return result;
}

export function agentCommandsCommand(ctx: Context): number {
  if (insideSandbox())
    fail(
      "Agent commands change your PC's PATH, so they are set up from your PC, not inside the sandbox.",
      'Run sandbox agent-commands on in a terminal on your PC.',
    );
  const action = ctx.options.positionals[0] ?? 'status';
  if (action === 'status') {
    const config = ctx.loaded.config;
    const found = agentCommands(config, ctx.storageRoot);
    console.log(
      'Agent commands (Beta): ' +
        (config.agentCommands.enabled ? c.green('on') : 'off') +
        c.dim('  (' + commandsDir(ctx.storageRoot) + ')'),
    );
    if (found.length)
      table(
        found.map((a) => [
          a.command,
          'sandboxed ' + a.harness + (config.agentCommands.enabled ? '' : ' when on'),
          c.dim('real: ' + a.real),
        ]),
      );
    else console.log(c.dim('No agents found on this PC (claude, codex, gemini ... on your PATH).'));
    if (!config.agentCommands.enabled) console.log(c.dim('Turn on with: sandbox agent-commands on'));
    return 0;
  }
  if (action !== 'on' && action !== 'off')
    fail('Unknown action "' + action + '".', 'Use: sandbox agent-commands [status|on|off]');
  const file = ctx.loaded.configPath ?? userConfigPath();
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const edited = editConfigText(text, ['agentCommands', 'enabled'], action === 'on' ? true : undefined);
  if ('problems' in edited)
    fail(
      'Could not change ' + file + ': ' + edited.problems.join('; '),
      'Fix the file with sandbox config check, then try again.',
    );
  writeFileAtomic(file, edited.text);
  const result = syncAgentCommands(ctx, loadConfig(file).config, true);
  if (result?.on) {
    console.log(
      'Agent commands (Beta) are on: ' +
        (result.commands.map((a) => a.command).join(', ') || 'no installed agents found yet'),
    );
    console.log(
      c.dim(
        'Open a new terminal, then type e.g. claude in a project folder: it starts in a hidden sandbox and attaches.',
      ),
    );
    console.log(
      c.dim(
        'Run the real one on this PC: set SANDBOX_AGENT_DIRECT=1 (PowerShell: $env:SANDBOX_AGENT_DIRECT=1). Turn off: sandbox agent-commands off',
      ),
    );
  } else console.log('Agent commands are off: claude, codex ... run on this PC again. Open a new terminal.');
  return 0;
}
