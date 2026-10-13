// Keeps credentials on this PC. Everything copied into the sandbox from your Claude settings (settings.json "env",
// MCP servers' env / headers / args in .claude.json) goes through here first: cloud and production credentials are
// removed unless you let them through with secrets.allow. Pure functions, so they are easy to test.
import type { Config } from '../../core/types.js';
import { SECRET_NAMES, SECRET_VALUES, SECRET_WORDS } from './secret-patterns.js';

export type SecretsConfig = Config['secrets'];

/** "AWS_REGION", "MY_*", "*_URL": * matches anything. Case-insensitive, like Windows variable names. */
function globMatch(pattern: string, name: string): boolean {
  return new RegExp(
    '^' +
      pattern
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
    'i',
  ).test(name);
}

export function isSecretName(name: string, secrets: SecretsConfig): boolean {
  // X-API-Key, x-auth-token, api.key: compared as X_API_KEY, X_AUTH_TOKEN, API_KEY.
  const upper = name.toUpperCase().replace(/[-\s.]/g, '_');
  return (
    SECRET_NAMES.some((r) => r.test(upper)) ||
    SECRET_WORDS.test(upper) ||
    secrets.patterns.some((p) => globMatch(p, name))
  );
}

export function isSecretValue(value: string): boolean {
  return SECRET_VALUES.some((r) => r.test(value));
}

/** Whether a variable (name and value) may go into the sandbox. secrets.allow always wins. */
export function mayPass(name: string, value: unknown, secrets: SecretsConfig): boolean {
  if (!secrets.strip || secrets.allow.some((p) => globMatch(p, name))) return true;
  return !isSecretName(name, secrets) && !(typeof value === 'string' && isSecretValue(value));
}

/** A copy of an env/headers map without the secrets; the names removed are added to `removed` (with `where`). */
export function stripVariables(vars: unknown, secrets: SecretsConfig, where: string, removed: string[]): unknown {
  if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) return vars;
  return Object.fromEntries(
    Object.entries(vars).filter(([name, value]) => {
      const ok = mayPass(name, value, secrets);
      if (!ok) removed.push(where + name);
      return ok;
    }),
  );
}

/** Claude settings keys that run commands to fetch credentials on this PC (they cannot work in the sandbox anyway). */
const CREDENTIAL_HELPERS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];

/** settings.json for the sandbox: secrets out of "env", credential helper commands removed. */
export function stripSettings(
  settings: Record<string, unknown>,
  secrets: SecretsConfig,
  removed: string[],
): Record<string, unknown> {
  if (!secrets.strip) return settings;
  const out: Record<string, unknown> = { ...settings };
  for (const key of CREDENTIAL_HELPERS.filter((k) => k in out)) {
    delete out[key];
    removed.push('settings.json ' + key);
  }
  if ('env' in out) out.env = stripVariables(out.env, secrets, 'settings.json env.', removed);
  return out;
}

/** One MCP server: secret env vars and headers removed, and secret-looking command-line arguments blanked. */
function stripServer(server: unknown, secrets: SecretsConfig, where: string, removed: string[]): unknown {
  if (typeof server !== 'object' || server === null) return server;
  const out = { ...(server as Record<string, unknown>) };
  if ('env' in out) out.env = stripVariables(out.env, secrets, where + ' env.', removed);
  if ('headers' in out) out.headers = stripVariables(out.headers, secrets, where + ' header ', removed);
  if (typeof out.url === 'string' && secrets.strip && isSecretValue(out.url)) {
    removed.push(where + ' url (it carried a credential)');
    out.url = out.url.replace(/([?&])[^=&#]+=[^&#]*/g, (m, sep: string) =>
      isSecretValue('?' + m.slice(1)) ? sep + m.slice(1).split('=')[0] + '=REMOVED' : m,
    );
  }
  if (Array.isArray(out.args) && secrets.strip) {
    out.args = out.args.map((arg: unknown, i: number) => {
      const previous = i > 0 ? String((out.args as unknown[])[i - 1]) : '';
      const [flag, inline] =
        typeof arg === 'string' && /^--?[\w-]+=/.test(arg)
          ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
          : [null, null];
      const secretFlag = (f: string): boolean => /^--?[\w-]+$/.test(f) && isSecretName(f.replace(/^-+/, ''), secrets);
      const flagged =
        typeof arg === 'string' &&
        (isSecretValue(arg) || (flag !== null && (secretFlag(flag) || isSecretValue(inline!))) || secretFlag(previous));
      if (flagged) removed.push(where + ' argument ' + (i + 1));
      return flagged ? '[removed by agent-sandbox]' : arg;
    });
  }
  return out;
}

/** Every MCP server in a .claude.json-shaped object (top level and per project). */
export function stripMcpServers(
  state: Record<string, unknown>,
  secrets: SecretsConfig,
  removed: string[],
): Record<string, unknown> {
  if (!secrets.strip) return state;
  const servers = (owner: Record<string, unknown>, where: string): Record<string, unknown> => {
    const list = owner.mcpServers;
    if (typeof list !== 'object' || list === null) return owner;
    return {
      ...owner,
      mcpServers: Object.fromEntries(
        Object.entries(list).map(([name, s]) => [name, stripServer(s, secrets, where + 'MCP ' + name, removed)]),
      ),
    };
  };
  const top = servers(state, '');
  const projects = top.projects as Record<string, Record<string, unknown>> | undefined;
  return projects
    ? { ...top, projects: Object.fromEntries(Object.entries(projects).map(([key, p]) => [key, servers(p, '')])) }
    : top;
}
