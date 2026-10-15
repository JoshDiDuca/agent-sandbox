// An OpenVPN profile (.ovpn) is untrusted data: it comes from the internet or from a file you were given, and OpenVPN
// can run programs from it (script-security, up, down, plugin ...) with administrator rights. Only directives on a
// short list of harmless ones are accepted; anything else is refused by name. Also answers where the tunnel connects
// (the `remote` lines), which the kill switch needs. Pure: no files, no network.

/** Directives that run a program, load code or touch a file on this machine. Refused with a clear reason. */
export const PROGRAM_DIRECTIVES = [
  'script-security',
  'up',
  'down',
  'up-restart',
  'down-pre',
  'route-up',
  'route-pre-down',
  'ipchange',
  'tls-verify',
  'plugin',
  'client-connect',
  'client-disconnect',
  'learn-address',
  'auth-user-pass-verify',
  'setenv-safe',
  'management',
  'management-client',
  'management-client-auth',
  'management-hold',
  'management-query-passwords',
  'config',
  'daemon',
  'service',
  'cd',
  'chroot',
  'setcon',
  'log',
  'log-append',
  'writepid',
  'status',
  'askpass',
  'engine',
  'bcast-dev',
  'dev-node',
  'cryptoapicert',
  'pkcs11-providers',
  'pkcs12',
  'http-proxy-user-pass',
  'tmp-dir',
] as const;

/** Directives that are only settings of the tunnel. Everything else is refused. */
const ALLOWED = new Set([
  'client',
  'tls-client',
  'dev',
  'dev-type',
  'proto',
  'remote',
  'remote-random',
  'remote-random-hostname',
  'resolv-retry',
  'nobind',
  'persist-key',
  'persist-tun',
  'remote-cert-tls',
  'remote-cert-eku',
  'ns-cert-type',
  'verify-x509-name',
  'cipher',
  'data-ciphers',
  'data-ciphers-fallback',
  'ncp-ciphers',
  'auth',
  'verb',
  'mute',
  'mute-replay-warnings',
  'reneg-sec',
  'reneg-bytes',
  'reneg-pkts',
  'tun-mtu',
  'tun-mtu-extra',
  'ping-timer-rem',
  'fast-io',
  'tls-timeout',
  'push-peer-info',
  'comp-noadapt',
  'link-mtu',
  'fragment',
  'mssfix',
  'sndbuf',
  'rcvbuf',
  'comp-lzo',
  'compress',
  'allow-compression',
  'key-direction',
  'auth-user-pass',
  'auth-nocache',
  'explicit-exit-notify',
  'pull',
  'pull-filter',
  'route-nopull',
  'route',
  'route-ipv6',
  'route-delay',
  'route-metric',
  'redirect-gateway',
  'redirect-private',
  'dhcp-option',
  'block-outside-dns',
  'register-dns',
  'topology',
  'tls-version-min',
  'tls-version-max',
  'tls-cipher',
  'tls-ciphersuites',
  'tls-groups',
  'tls-exit',
  'ping',
  'ping-restart',
  'ping-exit',
  'keepalive',
  'connect-retry',
  'connect-retry-max',
  'connect-timeout',
  'server-poll-timeout',
  'float',
  'ifconfig-nowarn',
  'tun-ipv6',
  'disable-dco',
  'windows-driver',
  'ignore-unknown-option',
  'opt-verify',
  'setenv',
  'key-method',
  'replay-window',
  'hand-window',
  'tran-window',
  'inactive',
  'socket-flags',
  'auth-retry',
  'ca',
  'cert',
  'key',
  'tls-auth',
  'tls-crypt',
  'tls-crypt-v2',
  'extra-certs',
  'dh',
]);

/** Directives that name a file: only allowed as inline sections (the certificates must be inside the profile). */
const FILE_DIRECTIVES = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'extra-certs', 'dh']);
/** The inline sections (<ca> ... </ca>); their text is data, never parsed as directives. */
const BLOCKS = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'extra-certs', 'dh']);

export const MAX_OVPN_BYTES = 256 * 1024;
const MAX_LINES = 4000;

/** Where the tunnel connects. `host` is an IPv4 address or a name. */
export interface OvpnRemote {
  readonly host: string;
  readonly port: number;
  readonly proto: 'udp' | 'tcp';
}

export type OvpnReport =
  | { readonly ok: true; readonly remotes: readonly OvpnRemote[] }
  | { readonly ok: false; readonly problems: readonly string[] };

const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

function directiveOf(line: string): { name: string; args: string[] } | null {
  const text = line.replace(/^\uFEFF/, '').trim();
  if (text === '' || text.startsWith('#') || text.startsWith(';')) return null;
  // OpenVPN accepts "--client" too.
  const parts = text.replace(/^-+/, '').split(/\s+/);
  return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

/**
 * Checks a profile. `ok: false` lists the problems; `ok: true` gives the servers it connects to. A profile must name at
 * least one remote, and every certificate must be inside it.
 */
export function inspectOvpn(text: string): OvpnReport {
  const problems: string[] = [];
  const found: { host: string; port: number; proto?: 'udp' | 'tcp' }[] = [];
  const refuse = (message: string): void => {
    if (problems.length < 20 && !problems.includes(message)) problems.push(message);
  };
  if (Buffer.byteLength(text, 'utf8') > MAX_OVPN_BYTES) return { ok: false, problems: ['the file is too big'] };
  if (text.includes('\0')) return { ok: false, problems: ['the file is not text'] };
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES) return { ok: false, problems: ['the file has too many lines'] };
  let block: string | null = null;
  let defaultProto: 'udp' | 'tcp' = 'udp';
  lines.forEach((line, i) => {
    const at = 'line ' + (i + 1) + ': ';
    const trimmed = line.trim();
    if (block) {
      if (trimmed.toLowerCase() === '</' + block + '>') block = null;
      else if (/^<\/?[A-Za-z-]+>$/.test(trimmed)) refuse(at + 'a section inside a section');
      return;
    }
    const open = /^<([A-Za-z0-9-]+)>$/.exec(trimmed);
    if (open) {
      const tag = open[1].toLowerCase();
      if (!BLOCKS.has(tag)) refuse(at + '<' + tag + '> is not allowed');
      block = tag;
      return;
    }
    const d = directiveOf(line);
    if (!d) return;
    if (!/^[a-z0-9-]{1,40}$/.test(d.name)) return refuse(at + 'a directive name with odd characters');
    if ((PROGRAM_DIRECTIVES as readonly string[]).includes(d.name))
      return refuse(at + d.name + ' runs a program or reads or writes a file on this machine');
    if (!ALLOWED.has(d.name)) return refuse(at + d.name + ' is not on the list of settings that are safe to accept');
    if (FILE_DIRECTIVES.has(d.name))
      return refuse(at + d.name + ' names a file: certificates must be inside the profile');
    if (d.name === 'auth-user-pass' && d.args.length > 0)
      return refuse(at + 'auth-user-pass names a file: the login is given separately');
    if (d.name === 'setenv' && !(d.args[0] === 'CLIENT_CERT' && d.args.length === 2))
      return refuse(at + 'setenv may only be CLIENT_CERT');
    if (d.name === 'proto') defaultProto = d.args[0]?.startsWith('tcp') ? 'tcp' : 'udp';
    if (d.name === 'remote') {
      const [host, port = '1194', proto] = d.args;
      if (!host || !HOST.test(host)) return refuse(at + 'remote needs a host name or an IPv4 address');
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return refuse(at + 'remote has an invalid port');
      found.push({ host, port: n, ...(proto ? { proto: proto.startsWith('tcp') ? 'tcp' : 'udp' } : {}) });
    }
  });
  // A remote without its own protocol uses the profile's proto line, wherever that line is.
  const remotes: OvpnRemote[] = found.map((r) => ({ host: r.host, port: r.port, proto: r.proto ?? defaultProto }));
  if (block) refuse('a <' + block + '> section is never closed');
  if (remotes.length === 0) refuse('it names no remote server');
  if (remotes.length > 64) refuse('it names too many servers');
  return problems.length ? { ok: false, problems } : { ok: true, remotes };
}

/** The servers of a safe profile; throws, saying why, when it is not (`what` names the file or source). */
export function assertSafeOvpn(text: string, what: string): readonly OvpnRemote[] {
  const report = inspectOvpn(text);
  if (report.ok) return report.remotes;
  throw new Error(
    what +
      ' was refused because it could run programs or is not a plain profile:\n  - ' +
      report.problems.slice(0, 5).join('\n  - '),
  );
}
