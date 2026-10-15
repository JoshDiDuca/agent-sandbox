// `sbx-agent`: install a configured agent from a terminal inside the sandbox (the agent commands call it the first
// time). Usage: sbx-agent list | sbx-agent install <agent>
import { agents } from './agent-installer.js';
import { agentCommand, agentPaths } from './agent-files.js';
import { toolsDir } from '../runtime/paths.js';
import { exists } from '../runtime/fs.js';
import { session } from '../runtime/session.js';

/** Runs one sbx-agent command; returns the exit code. Prints, as the command line tool it is. */
export async function runSbxAgent(argv: readonly string[]): Promise<number> {
  const known = session.agents ?? {};
  const [verb, name] = argv;
  if (verb === 'list' || verb === undefined) {
    for (const [agent, harness] of Object.entries(known)) {
      const p = agentPaths(toolsDir, agent, harness);
      const installed = (p.exe !== null && exists(p.exe)) || (p.cmd !== null && exists(p.cmd));
      console.log(agentCommand(agent, harness).padEnd(14) + (installed ? 'installed' : 'not installed yet'));
    }
    return 0;
  }
  const harness = verb === 'install' && name ? known[name] : undefined;
  if (!harness) {
    console.error(
      verb === 'install' && name
        ? 'Unknown agent "' + name + '". Configured agents: ' + Object.keys(known).join(', ')
        : 'Usage: sbx-agent list | sbx-agent install <agent>',
    );
    return 1;
  }
  try {
    await agents.provision(name!, harness, process.env, false);
  } catch (e) {
    console.error('Could not install ' + name + ': ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
  return 0;
}
