// The network settings as rules: which hosts the sandbox may reach (network.allowOnly), which never (blockHosts), and
// the ports forwarded from this PC into the sandbox. Pure (tested); the guest applies them (guest/setup/network.ts,
// guest/netproxy.ts) and the host runs the forwarders (host/port-forward.ts).

/** A host name or a "*.example.com" pattern (lower case, no scheme, no port). */
export const HOST_PATTERN = /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/i;

/**
 * What "@developer" stands for in allowOnly: package registries, source hosts, toolchain downloads and the AI
 * providers the agents talk to. Enough for an agent to install dependencies, push to GitHub and reach its model.
 */
export const DEVELOPER_HOSTS = [
  // AI providers
  'api.anthropic.com', 'claude.ai', '*.claude.ai', 'console.anthropic.com', 'statsig.anthropic.com', 'sentry.io', '*.sentry.io',
  'api.openai.com', 'chatgpt.com', '*.openai.com', 'generativelanguage.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com',
  // source hosts
  'github.com', '*.github.com', '*.githubusercontent.com', 'codeload.github.com', 'gitlab.com', '*.gitlab.com', 'bitbucket.org',
  // package registries
  'registry.npmjs.org', '*.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'index.crates.io', 'static.crates.io',
  'proxy.golang.org', 'sum.golang.org', 'repo1.maven.org', 'repo.maven.apache.org', 'plugins.gradle.org', 'services.gradle.org', 'api.nuget.org',
  '*.nuget.org', 'rubygems.org', 'index.rubygems.org', 'repo.packagist.org', 'packagist.org', 'jsr.io', 'deno.land',
  // toolchains
  'nodejs.org', '*.nodejs.org', 'static.rust-lang.org', 'go.dev', 'dl.google.com', 'aka.ms', 'download.visualstudio.microsoft.com',
  'dotnetcli.azureedge.net', 'builds.dotnet.microsoft.com', 'api.adoptium.net', 'objects.githubusercontent.com', 'marketplace.visualstudio.com',
  '*.gallerycdn.vsassets.io', '*.vscode-cdn.net', 'update.code.visualstudio.com',
];

/** The allowOnly list with "@developer" expanded, lower case, without duplicates. */
export const expandAllowList = (list: string[]): string[] =>
  [...new Set(list.flatMap((h) => (h.trim().toLowerCase() === '@developer' ? DEVELOPER_HOSTS : [h])).map((h) => h.trim().toLowerCase()).filter((h) => HOST_PATTERN.test(h)))];

/** Does `host` match one of the patterns? "*.example.com" matches its subdomains (not example.com itself). */
export const hostAllowed = (host: string, patterns: string[]): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
};

export const HOSTS_BEGIN = '# >>> windows-development-sandbox network.blockHosts';
export const HOSTS_END = '# <<< windows-development-sandbox network.blockHosts';

/** The hosts file with our block section replaced by `hosts` (each sent to 0.0.0.0 and ::); everything else stays. */
export const withBlockedHosts = (hostsFile: string, hosts: string[]): string => {
  const begin = hostsFile.indexOf(HOSTS_BEGIN);
  const end = hostsFile.indexOf(HOSTS_END);
  const outside = begin >= 0 && end > begin ? hostsFile.slice(0, begin) + hostsFile.slice(end + HOSTS_END.length) : hostsFile;
  const clean = [...new Set(hosts.map((h) => h.trim().toLowerCase()).filter((h) => HOST_PATTERN.test(h) && !h.startsWith('*.')))];
  const base = outside.replace(/\s+$/, '');
  if (!clean.length) return base + '\r\n';
  return [base, HOSTS_BEGIN, ...clean.flatMap((h) => ['0.0.0.0 ' + h, ':: ' + h]), HOSTS_END, ''].join('\r\n');
};

/** One forwarded port: <pc> on this PC (localhost only) reaches <sandbox> inside. */
export interface PortForward { pc: number; sandbox: number }

/**
 * The port the sandbox's relay for forward `index` listens on (it connects on to localhost:<sandbox> inside, so a
 * server that only listens on localhost is reachable too). Out of the range Windows hands out for outgoing connections.
 */
export const relayPort = (index: number): number => 38100 + index;

/** The address the sandbox's built-in proxy listens on (allowOnly). */
export const PROXY_PORT = 38080;
