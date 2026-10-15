// Agents: is the default agent one of those configured, and for each agent that keeps a login, is a saved login in
// use in this data folder. Looks only; logins are never changed here.
import { errMsg } from '../../../../core/util/index.js';
import { AccountStore, AgentAccountStore, type AccountRow } from '../../../../host/profile/index.js';
import type { Check, Finding, RepairEnv } from '../types.js';
import { ok, plural } from './common.js';

function rowsOf(env: RepairEnv, name: string, loginFiles: readonly string[] | undefined): AccountRow[] {
  if (name === 'claude') return new AccountStore(env.storageRoot).list(env.dataPath);
  return loginFiles ? new AgentAccountStore(env.storageRoot, name, loginFiles).list(env.dataPath) : [];
}

export const AGENT_CHECKS: Check[] = [
  {
    id: 'agents-default',
    group: 'Agents & tools',
    name: 'Default agent',
    run: (env: RepairEnv): Finding => {
      const config = env.ctx.loaded.config;
      const name = env.ctx.options.harness ?? config.defaultHarness;
      const harness = config.harnesses[name];
      if (!harness)
        return {
          status: 'needs-you',
          detail:
            '"' + name + '" is not one of your configured agents (' + Object.keys(config.harnesses).join(', ') + ')',
          means: 'sandbox launch has no agent to start.',
          fix: 'Set defaultHarness in your settings to one of those names (sandbox config path shows the file).',
        };
      return ok(name + ' (' + plural(Object.keys(config.harnesses).length, 'agent') + ' configured)');
    },
  },
  {
    id: 'agents-logins',
    group: 'Agents & tools',
    name: 'Agent logins',
    run: (env: RepairEnv): Finding => {
      const harnesses = env.ctx.loaded.config.harnesses;
      const lines: string[] = [];
      const idle: string[] = [];
      for (const [name, harness] of Object.entries(harnesses)) {
        let rows: AccountRow[];
        try {
          rows = rowsOf(env, name, harness.home?.loginFiles);
        } catch (e) {
          lines.push(name + ': saved logins cannot be read (' + errMsg(e) + ')');
          idle.push(name);
          continue;
        }
        if (!rows.length) continue;
        const active = rows.find((r) => r.isActive);
        if (active) lines.push(name + ': ' + active.name + ' is in use (' + plural(rows.length, 'login') + ' saved)');
        else {
          lines.push(name + ': ' + plural(rows.length, 'login') + ' saved, none in use here');
          idle.push(name);
        }
      }
      if (!lines.length) return ok('no saved logins (sign in inside the sandbox the first time)');
      if (!idle.length) return { ...ok(lines.join('; ')) };
      return {
        status: 'warn',
        detail: lines.join('; '),
        means: 'The sandbox starts signed out for ' + idle.join(', ') + ' until you pick a saved login.',
        fix: 'Run: sandbox account use <name>' + (idle[0] === 'claude' ? '' : ' --agent ' + idle[0]),
      };
    },
  },
];
