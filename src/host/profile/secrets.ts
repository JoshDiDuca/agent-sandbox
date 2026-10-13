// Keeps credentials on this PC. Everything copied into the sandbox from your Claude settings (settings.json "env",
// MCP servers' env / headers / args in .claude.json) goes through here first: cloud and production credentials are
// removed unless you let them through with secrets.allow. Pure functions, so they are easy to test.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../../core/types.js';

export type SecretsConfig = Config['secrets'];

/** Variable names that are credentials by definition: cloud providers, hosting, CI, registries, payment, AI APIs, ... */
const SECRET_NAMES: RegExp[] = [
  /^AWS_/,
  /^AMAZON_/,
  /^AZURE_/,
  /^ARM_(CLIENT|TENANT|SUBSCRIPTION|ACCESS)_/,
  /^MSAL_/,
  /^CLOUDFLARE_/,
  /^CF_(API|ACCOUNT|ZONE|ACCESS)/,
  /^GOOGLE_(APPLICATION_CREDENTIALS|API_KEY|CLOUD_|CLIENT_SECRET)/,
  /^GCP_/,
  /^GCLOUD_/,
  /^GOOGLE_GHA_/,
  /^FIREBASE_/,
  /^DIGITALOCEAN_/,
  /^DO_(API|AUTH)_/,
  /^LINODE_/,
  /^HCLOUD_/,
  /^OCI_/,
  /^ALIBABA_CLOUD_/,
  /^ALICLOUD_/,
  /^IBMCLOUD_/,
  /^HEROKU_/,
  /^VERCEL_/,
  /^NETLIFY_/,
  /^RENDER_API/,
  /^FLY_(API|ACCESS)_/,
  /^RAILWAY_/,
  /^SUPABASE_/,
  /^NEON_/,
  /^PLANETSCALE_/,
  /^GITHUB_TOKEN$/,
  /^GH_TOKEN$/,
  /^GH_ENTERPRISE_TOKEN$/,
  /^GITHUB_PAT/,
  /^GITLAB_/,
  /^BITBUCKET_/,
  /^CIRCLE_TOKEN$/,
  /^TRAVIS_/,
  /^BUILDKITE_/,
  /^NPM_TOKEN$/,
  /^NODE_AUTH_TOKEN$/,
  /^YARN_NPM_AUTH/,
  /^NUGET_(API_KEY|AUTH)/,
  /^PYPI_/,
  /^TWINE_/,
  /^CARGO_REGISTRY_TOKEN$/,
  /^GEM_HOST_API_KEY$/,
  /^DOCKER_(PASSWORD|TOKEN|AUTH)/,
  /^REGISTRY_(PASSWORD|TOKEN)/,
  /^KUBECONFIG$/,
  /^KUBE_TOKEN$/,
  /^HELM_/,
  /^VAULT_/,
  /^CONSUL_HTTP_TOKEN$/,
  /^NOMAD_TOKEN$/,
  /^TF_VAR_/,
  /^TF_TOKEN_/,
  /^TFE_TOKEN$/,
  /^PULUMI_ACCESS_TOKEN$/,
  /^SPACELIFT_/,
  /^ANSIBLE_VAULT/,
  /^STRIPE_/,
  /^PAYPAL_/,
  /^BRAINTREE_/,
  /^SQUARE_/,
  /^ADYEN_/,
  /^TWILIO_/,
  /^SENDGRID_/,
  /^MAILGUN_/,
  /^POSTMARK_/,
  /^MAILCHIMP_/,
  /^RESEND_/,
  /^SLACK_/,
  /^DISCORD_(TOKEN|BOT|WEBHOOK)/,
  /^TELEGRAM_BOT/,
  /^SENTRY_(AUTH|DSN)/,
  /^DATADOG_/,
  /^DD_(API|APP)_KEY$/,
  /^NEW_RELIC_/,
  /^HONEYCOMB_/,
  /^OPENAI_/,
  /^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^GEMINI_API_KEY$/,
  /^MISTRAL_API_KEY$/,
  /^COHERE_API_KEY$/,
  /^GROQ_API_KEY$/,
  /^HF_TOKEN$/,
  /^HUGGING_?FACE_/,
  /^REPLICATE_API/,
  /^PINECONE_/,
  /^ELEVENLABS_/,
  /^DATABASE_URL$/,
  /^.*_DATABASE_URL$/,
  /^(PG|POSTGRES|MYSQL|MARIADB|MSSQL|MONGO(DB)?|REDIS|ELASTIC(SEARCH)?|RABBITMQ|SNOWFLAKE|DATABRICKS)_/,
  /^SSH_AUTH_SOCK$/,
  /^GPG_/,
  /^OP_(SERVICE_ACCOUNT|CONNECT)_/,
  /^BWS_ACCESS_TOKEN$/,
  /^DOPPLER_/,
  /^INFISICAL_/,
];

/** Any name that says what it holds: ..._TOKEN, ..._SECRET, PASSWORD, API_KEY, ..._PRIVATE_KEY, connection strings, ... */
const SECRET_WORDS =
  /(^|_)(PROD|PRODUCTION|LIVE|SECRETS?|TOKENS?|PASSWORDS?|PASSWD|PWD|PASS|API_?KEYS?|ACCESS_?KEYS?|PRIVATE_?KEYS?|SIGNING_?KEYS?|CREDENTIALS?|CREDS|AUTH|AUTHORIZATION|BEARER|COOKIES?|SESSION_?KEYS?|CONN(ECTION)?_?STR(ING)?|DSN|WEBHOOK(_URL)?|CLIENT_?SECRET|SAS|SALT|PAT)(_|$)/;

/** Values that are credentials whatever they are called. */
const SECRET_VALUES: RegExp[] = [
  /\b(AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/, // AWS access key ids
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bsk-(ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}/,
  /\b[rs]k_live_[A-Za-z0-9]{20,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bya29\.[0-9A-Za-z_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AccountKey=[A-Za-z0-9+/=]{20,}/i,
  /SharedAccessSignature=|[?&]sig=[A-Za-z0-9%+/=]{20,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i, // user:password@host in any URL (database URLs, registries)
  /\bBearer\s+\S{16,}/i,
  /\bBasic\s+[A-Za-z0-9+/=]{12,}/i,
  /[?&](api[_-]?key|apikey|access[_-]?token|token|key|secret|password|sig|signature|auth)=[^&\s]{8,}/i, // credentials in a URL
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWTs
];

/** "AWS_REGION", "MY_*", "*_URL": * matches anything. Case-insensitive, like Windows variable names. */
const globMatch = (pattern: string, name: string): boolean =>
  new RegExp(
    '^' +
      pattern
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
    'i',
  ).test(name);

export const isSecretName = (name: string, secrets: SecretsConfig): boolean => {
  // X-API-Key, x-auth-token, api.key: compared as X_API_KEY, X_AUTH_TOKEN, API_KEY.
  const upper = name.toUpperCase().replace(/[-\s.]/g, '_');
  return (
    SECRET_NAMES.some((r) => r.test(upper)) ||
    SECRET_WORDS.test(upper) ||
    secrets.patterns.some((p) => globMatch(p, name))
  );
};

export const isSecretValue = (value: string): boolean => SECRET_VALUES.some((r) => r.test(value));

/** Whether a variable (name and value) may go into the sandbox. secrets.allow always wins. */
export const mayPass = (name: string, value: unknown, secrets: SecretsConfig): boolean => {
  if (!secrets.strip || secrets.allow.some((p) => globMatch(p, name))) return true;
  return !isSecretName(name, secrets) && !(typeof value === 'string' && isSecretValue(value));
};

/** A copy of an env/headers map without the secrets; the names removed are added to `removed` (with `where`). */
export const stripVariables = (vars: unknown, secrets: SecretsConfig, where: string, removed: string[]): unknown => {
  if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) return vars;
  return Object.fromEntries(
    Object.entries(vars).filter(([name, value]) => {
      const ok = mayPass(name, value, secrets);
      if (!ok) removed.push(where + name);
      return ok;
    }),
  );
};

/** Claude settings keys that run commands to fetch credentials on this PC (they cannot work in the sandbox anyway). */
const CREDENTIAL_HELPERS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];

/** settings.json for the sandbox: secrets out of "env", credential helper commands removed. */
export const stripSettings = (
  settings: Record<string, unknown>,
  secrets: SecretsConfig,
  removed: string[],
): Record<string, unknown> => {
  if (!secrets.strip) return settings;
  const out: Record<string, unknown> = { ...settings };
  for (const key of CREDENTIAL_HELPERS.filter((k) => k in out)) {
    delete out[key];
    removed.push('settings.json ' + key);
  }
  if ('env' in out) out.env = stripVariables(out.env, secrets, 'settings.json env.', removed);
  return out;
};

/** One MCP server: secret env vars and headers removed, and secret-looking command-line arguments blanked. */
const stripServer = (server: unknown, secrets: SecretsConfig, where: string, removed: string[]): unknown => {
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
};

/** Every MCP server in a .claude.json-shaped object (top level and per project). */
export const stripMcpServers = (
  state: Record<string, unknown>,
  secrets: SecretsConfig,
  removed: string[],
): Record<string, unknown> => {
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
};

/** Files in the workspace that usually hold secrets. The agent CAN read them (the whole folder is mapped); we only warn. */
const SECRET_FILES =
  /^(\.env(\..+)?|\.envrc|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|tfvars|ovpn)|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|service[-_]?account.*\.json|id_(rsa|ed25519|ecdsa)|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/i;
const TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i;

/** Secret-looking files in the workspace root and one folder down (skipping dependency folders). */
export const findSecretFiles = (workspace: string): string[] => {
  const list = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const hit = (name: string): boolean => SECRET_FILES.test(name) && !TEMPLATE.test(name);
  const top = list(workspace);
  const below = top
    .filter((d) => d.isDirectory() && !/^(node_modules|\.git|vendor|target|dist|build|\.venv|venv)$/i.test(d.name))
    .flatMap((d) =>
      list(path.join(workspace, d.name))
        .filter((f) => f.isFile() && hit(f.name))
        .map((f) => d.name + '\\' + f.name),
    );
  return [...top.filter((d) => d.isFile() && hit(d.name)).map((d) => d.name), ...below];
};
