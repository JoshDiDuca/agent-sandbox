// `sandbox agent-commands [status|on|off]` (Beta): typing claude, codex ... on this PC starts them in a hidden sandbox.
import type { Config } from '../../core/types.js';
import { fail } from '../../core/util/index.js';
import type { Reconciled } from '../../host/agent-commands/index.js';
import { c, table } from '../output/index.js';
import { AgentCommandsService } from '../services/index.js';
import { type Context } from './context.js';

/** Brings this PC in line with agentCommands and says what changed (used after on/off, settings and launch). */
export function syncAgentCommands(ctx: Context, config: Config, quiet = false): Reconciled | null {
  const result = new AgentCommandsService(ctx).reconcile(config);
  if (!result || !result.changed || quiet) return result;
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
  const service = new AgentCommandsService(ctx);
  service.assertOnPc();
  const action = ctx.options.positionals[0] ?? 'status';
  if (action === 'status') {
    const { enabled, dir, found } = service.status();
    console.log('Agent commands (Beta): ' + (enabled ? c.green('on') : 'off') + c.dim('  (' + dir + ')'));
    if (found.length)
      table(
        found.map((a) => [a.command, 'sandboxed ' + a.harness + (enabled ? '' : ' when on'), c.dim('real: ' + a.real)]),
      );
    else console.log(c.dim('No agents found on this PC (claude, codex, gemini ... on your PATH).'));
    if (!enabled) console.log(c.dim('Turn on with: sandbox agent-commands on'));
    return 0;
  }
  if (action !== 'on' && action !== 'off')
    fail('Unknown action "' + action + '".', 'Use: sandbox agent-commands [status|on|off]');
  const result = service.setEnabled(action === 'on');
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
