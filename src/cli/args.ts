import { fail } from '../core/util.js';

export interface CliOptions {
  command: string; positionals: string[]; passthrough: string[];
  config?: string; workspace?: string; harness?: string; account?: string; node?: string; python?: string;
  scripts: string[]; headless?: boolean; terminal: boolean; noAgent: boolean; trustConfig: boolean; noLocalConfig: boolean;
  personal: boolean; fromHost: boolean; noRestart: boolean; follow: boolean; json: boolean; timeout: number; days: number;
}

type Spec = { key: keyof CliOptions; value?: 'string' | 'number' | 'list'; set?: unknown };

const OPTIONS: Record<string, Spec> = {
  '--config': { key: 'config', value: 'string' },
  '--workspace': { key: 'workspace', value: 'string' },
  '--harness': { key: 'harness', value: 'string' },
  '--account': { key: 'account', value: 'string' },
  '--node': { key: 'node', value: 'string' },
  '--python': { key: 'python', value: 'string' },
  '--script': { key: 'scripts', value: 'list' },
  '--timeout': { key: 'timeout', value: 'number' },
  '--days': { key: 'days', value: 'number' },
  '--headless': { key: 'headless', set: true },
  '--window': { key: 'headless', set: false },
  '--terminal': { key: 'terminal', set: true },
  '-t': { key: 'terminal', set: true },
  '--no-agent': { key: 'noAgent', set: true },
  '--trust-config': { key: 'trustConfig', set: true },
  '--no-local-config': { key: 'noLocalConfig', set: true },
  '--personal': { key: 'personal', set: true },
  '--from-host': { key: 'fromHost', set: true },
  '--no-restart': { key: 'noRestart', set: true },
  '--follow': { key: 'follow', set: true },
  '-f': { key: 'follow', set: true },
  '--json': { key: 'json', set: true },
};

const defaults = (command: string): CliOptions => ({
  command, positionals: [], passthrough: [], scripts: [], terminal: false, noAgent: false, trustConfig: false, noLocalConfig: false,
  personal: false, fromHost: false, noRestart: false, follow: false, json: false, timeout: 600, days: 7,
});

/**
 * Parses `agent-sandbox <command> [options] [-- passthrough]`. In wrapper mode (claude-sbx and friends) unknown
 * tokens are not errors: they go to the agent, so `claude-sbx --terminal --continue` just works.
 */
export const parseArgs = (argv: string[], wrapper = false): CliOptions => {
  const [first, ...rest] = wrapper ? ['launch', ...argv] : argv;
  const options = defaults(first ?? '');
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--') { options.passthrough.push(...rest.slice(i + 1)); break; }
    const [name, inline] = token.startsWith('--') && token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
    const spec = OPTIONS[name];
    if (!spec) {
      if (wrapper) options.passthrough.push(token);
      else if (token.startsWith('-')) fail('Unknown option: ' + token + ' (see agent-sandbox help)');
      else options.positionals.push(token);
      continue;
    }
    if (!spec.value) { (options as unknown as Record<string, unknown>)[spec.key] = spec.set; continue; }
    const value = inline ?? rest[++i];
    if (value === undefined) fail(name + ' needs a value');
    const record = options as unknown as Record<string, unknown>;
    if (spec.value === 'list') (record[spec.key] as string[]).push(value);
    else if (spec.value === 'number') { const n = Number(value); if (!Number.isFinite(n) || n <= 0) fail(name + ' needs a positive number'); record[spec.key] = n; }
    else record[spec.key] = value;
  }
  return options;
};
