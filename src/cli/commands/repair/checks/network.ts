// The network: can this PC reach GitHub (updates and tool downloads), and is a proxy set that makes sense.
import type { Check, Finding, RepairEnv } from '../types.js';
import { ok } from './common.js';

const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const;
const REACH_MS = 6000;

/** The first proxy variable that is set: [name, value]. */
export function proxyFromEnvironment(env: NodeJS.ProcessEnv = process.env): [string, string] | null {
  for (const name of PROXY_VARIABLES) {
    const value = env[name]?.trim();
    if (value) return [name, value];
  }
  return null;
}

/** null when the value is a proxy address the downloads can use, else why not. */
export function proxyProblem(value: string): string | null {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'http://' + value);
    return url.hostname ? null : 'it has no host name';
  } catch {
    return 'it is not an address';
  }
}

export const NETWORK_CHECKS: Check[] = [
  {
    id: 'net-proxy',
    group: 'Network',
    name: 'Proxy',
    run: (): Finding => {
      const proxy = proxyFromEnvironment();
      if (!proxy) return ok('no proxy variable set');
      const problem = proxyProblem(proxy[1]);
      if (!problem) return ok(proxy[0] + ' = ' + proxy[1].replace(/\/\/[^@/]*@/, '//***@'));
      return {
        status: 'warn',
        detail: proxy[0] + ' is set but ' + problem,
        means: 'Downloads that follow the proxy settings will fail.',
        fix: 'Set ' + proxy[0] + ' to an address like http://proxy.example.com:8080, or remove it.',
      };
    },
  },
  {
    id: 'net-github',
    group: 'Network',
    name: 'GitHub',
    checking: 'whether GitHub can be reached',
    timeoutMs: REACH_MS + 4000,
    run: async (env: RepairEnv): Promise<Finding> => {
      if (await env.system.reachable('https://github.com', REACH_MS)) return ok('github.com answers');
      return {
        status: 'warn',
        detail: 'github.com did not answer within ' + REACH_MS / 1000 + ' seconds',
        means: 'Updates and some tool downloads need it. Without it they fail or use what is already saved.',
        fix: 'Check your internet connection, VPN or proxy, then run this again.',
      };
    },
  },
];
