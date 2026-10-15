// A WireGuard config (.conf) is untrusted data: it comes from a file you were given, and WireGuard for Windows runs the
// programs of PreUp/PostUp/PreDown/PostDown with administrator rights. Only the settings on a short list are accepted;
// anything else is refused by name, and the config that is handed on is written again from the checked values, never
// copied. Problem messages name keys and lines, never values (the private and preshared keys are secrets). Also answers
// where the tunnel connects and which address it has, which the kill switch needs. Pure: no files, no network.
import net from 'node:net';

export const MAX_WIREGUARD_BYTES = 16 * 1024;
const MAX_LINES = 300;
const MAX_PEERS = 16;

/** Keys that run a program, change the routes or write the config back. Refused with a clear reason. */
export const WIREGUARD_PROGRAM_KEYS = ['preup', 'postup', 'predown', 'postdown', 'table', 'saveconfig'] as const;

const INTERFACE_KEYS = new Set(['privatekey', 'address', 'dns', 'mtu', 'listenport']);
const PEER_KEYS = new Set(['publickey', 'presharedkey', 'allowedips', 'endpoint', 'persistentkeepalive']);
/** Keys that may be given more than once (their values are joined). */
const LIST_KEYS = new Set(['address', 'dns', 'allowedips']);

const KEY = /^[A-Za-z0-9+/]{43}=$/;
const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

export interface WireguardPeer {
  readonly publicKey: string;
  readonly presharedKey?: string;
  readonly allowedIps: readonly string[];
  readonly endpointHost: string;
  readonly endpointPort: number;
  readonly keepalive?: number;
}

/** A checked config. Holds secrets (privateKey, presharedKey): never log it or write it to session.json. */
export interface WireguardConfig {
  readonly privateKey: string;
  readonly addresses: readonly string[];
  readonly dns: readonly string[];
  readonly mtu?: number;
  readonly listenPort?: number;
  readonly peers: readonly WireguardPeer[];
}

export type WireguardReport =
  | { readonly ok: true; readonly config: WireguardConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Where the tunnel connects (the kill switch allows these, over udp). */
export interface WireguardEndpoint {
  readonly host: string;
  readonly port: number;
}

function validCidr(text: string): boolean {
  const [addr, prefix, ...rest] = text.split('/');
  if (rest.length > 0 || !addr) return false;
  const version = net.isIP(addr);
  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

const inRange = (text: string, low: number, high: number): number | null => {
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n >= low && n <= high ? n : null;
};

const splitList = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Checks a config. `ok: false` lists the problems (no values in them); `ok: true` gives the checked settings. It needs
 * one [Interface] with a PrivateKey and an IPv4 Address, and at least one [Peer] with PublicKey, AllowedIPs and an
 * Endpoint that is a name or an IPv4 address (the kill switch rules are IPv4).
 */
export function inspectWireguard(text: string): WireguardReport {
  const problems: string[] = [];
  const refuse = (message: string): void => {
    if (problems.length < 20 && !problems.includes(message)) problems.push(message);
  };
  if (Buffer.byteLength(text, 'utf8') > MAX_WIREGUARD_BYTES) return { ok: false, problems: ['the file is too big'] };
  if (text.includes('\0')) return { ok: false, problems: ['the file is not text'] };
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  if (lines.length > MAX_LINES) return { ok: false, problems: ['the file has too many lines'] };

  type Section = { kind: 'interface' | 'peer'; values: Map<string, string[]> };
  const sections: Section[] = [];
  let current: Section | null = null;
  lines.forEach((raw, i) => {
    const at = 'line ' + (i + 1) + ': ';
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const header = /^\[([A-Za-z]{1,20})\]$/.exec(line);
    if (header) {
      const name = header[1].toLowerCase();
      if (name !== 'interface' && name !== 'peer') {
        current = null;
        return refuse(at + '[' + name + '] is not allowed');
      }
      current = { kind: name, values: new Map() };
      sections.push(current);
      return;
    }
    const pair = /^([A-Za-z]{1,40})\s*=\s*(.*)$/.exec(line);
    if (!pair) return refuse(at + 'not a "Key = value" line');
    const key = pair[1].toLowerCase();
    if ((WIREGUARD_PROGRAM_KEYS as readonly string[]).includes(key))
      return refuse(at + pair[1] + ' runs a program or changes how the tunnel is routed or saved');
    if (!current) return refuse(at + pair[1] + ' is outside a section');
    if (!(current.kind === 'interface' ? INTERFACE_KEYS : PEER_KEYS).has(key))
      return refuse(at + pair[1] + ' is not on the list of settings that are safe to accept');
    const seen = current.values.get(key);
    if (seen && !LIST_KEYS.has(key)) return refuse(at + pair[1] + ' is given twice');
    current.values.set(key, [...(seen ?? []), pair[2].trim()]);
  });

  const one = (s: Section, key: string): string | undefined => s.values.get(key)?.[0];
  const joined = (s: Section, key: string): string[] => (s.values.get(key) ?? []).flatMap(splitList);

  const interfaces = sections.filter((s) => s.kind === 'interface');
  const peers = sections.filter((s) => s.kind === 'peer');
  if (interfaces.length !== 1) refuse('it needs exactly one [Interface] section');
  if (peers.length === 0) refuse('it has no [Peer] section');
  if (peers.length > MAX_PEERS) refuse('it has too many [Peer] sections');
  if (problems.length) return { ok: false, problems };

  const face = interfaces[0];
  const privateKey = one(face, 'privatekey');
  if (!privateKey) refuse('[Interface] has no PrivateKey');
  else if (!KEY.test(privateKey)) refuse('PrivateKey is not a WireGuard key (44 characters of base64)');
  const addresses = joined(face, 'address');
  if (addresses.length === 0 || !addresses.every(validCidr)) refuse('[Interface] needs valid Address values');
  else if (!addresses.some((a) => net.isIPv4(a.split('/')[0])))
    refuse('Address needs an IPv4 address (the kill switch works on IPv4)');
  const dns = joined(face, 'dns');
  if (!dns.every((d) => net.isIP(d) !== 0)) refuse('DNS may only list IP addresses');
  const mtuText = one(face, 'mtu');
  const mtu = mtuText === undefined ? undefined : inRange(mtuText, 576, 1500);
  if (mtuText !== undefined && mtu === null) refuse('MTU must be a number from 576 to 1500');
  const portText = one(face, 'listenport');
  const listenPort = portText === undefined ? undefined : inRange(portText, 1, 65535);
  if (portText !== undefined && listenPort === null) refuse('ListenPort must be a number from 1 to 65535');

  const checked: WireguardPeer[] = [];
  peers.forEach((p, n) => {
    const who = '[Peer] ' + (n + 1) + ': ';
    const publicKey = one(p, 'publickey');
    if (!publicKey || !KEY.test(publicKey)) return refuse(who + 'PublicKey is missing or not a WireGuard key');
    const preshared = one(p, 'presharedkey');
    if (preshared !== undefined && !KEY.test(preshared)) return refuse(who + 'PresharedKey is not a WireGuard key');
    const allowed = joined(p, 'allowedips');
    if (allowed.length === 0 || !allowed.every(validCidr)) return refuse(who + 'AllowedIPs is missing or invalid');
    const endpoint = one(p, 'endpoint');
    const m = endpoint ? /^([^:[\]]+):(\d{1,5})$/.exec(endpoint) : null;
    if (!m || !HOST.test(m[1]) || inRange(m[2], 1, 65535) === null)
      return refuse(who + 'Endpoint must be host:port with a name or an IPv4 address');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(m[1]) && !net.isIPv4(m[1])) return refuse(who + 'Endpoint is not a valid address');
    const keepText = one(p, 'persistentkeepalive');
    let keepalive: number | undefined;
    if (keepText !== undefined && keepText.toLowerCase() !== 'off') {
      const k = inRange(keepText, 0, 65535);
      if (k === null) return refuse(who + 'PersistentKeepalive must be a number or off');
      keepalive = k;
    }
    checked.push({
      publicKey,
      ...(preshared ? { presharedKey: preshared } : {}),
      allowedIps: allowed,
      endpointHost: m[1],
      endpointPort: Number(m[2]),
      ...(keepalive !== undefined ? { keepalive } : {}),
    });
  });
  if (problems.length || !privateKey) return { ok: false, problems };
  return {
    ok: true,
    config: {
      privateKey,
      addresses,
      dns,
      ...(typeof mtu === 'number' ? { mtu } : {}),
      ...(typeof listenPort === 'number' ? { listenPort } : {}),
      peers: checked,
    },
  };
}

/** The checked config; throws, saying why (never with a key), when it is not safe. `what` names the file. */
export function assertSafeWireguard(text: string, what: string): WireguardConfig {
  const report = inspectWireguard(text);
  if (report.ok) return report.config;
  throw new Error(
    what +
      ' was refused because it could run programs or is not a plain WireGuard config:\n  - ' +
      report.problems.slice(0, 5).join('\n  - '),
  );
}

/** The config as text, written from the checked values. `endpointIps` puts an address in a peer's place. */
export function renderWireguard(config: WireguardConfig, endpointIps: Readonly<Record<number, string>> = {}): string {
  const out = ['[Interface]', 'PrivateKey = ' + config.privateKey, 'Address = ' + config.addresses.join(', ')];
  if (config.dns.length) out.push('DNS = ' + config.dns.join(', '));
  if (config.mtu !== undefined) out.push('MTU = ' + config.mtu);
  if (config.listenPort !== undefined) out.push('ListenPort = ' + config.listenPort);
  config.peers.forEach((p, i) => {
    out.push('', '[Peer]', 'PublicKey = ' + p.publicKey);
    if (p.presharedKey) out.push('PresharedKey = ' + p.presharedKey);
    out.push(
      'AllowedIPs = ' + p.allowedIps.join(', '),
      'Endpoint = ' + (endpointIps[i] ?? p.endpointHost) + ':' + p.endpointPort,
    );
    if (p.keepalive !== undefined) out.push('PersistentKeepalive = ' + p.keepalive);
  });
  return out.join('\r\n') + '\r\n';
}

export function wireguardEndpoints(config: WireguardConfig): WireguardEndpoint[] {
  return config.peers.map((p) => ({ host: p.endpointHost, port: p.endpointPort }));
}

/** The tunnel's own IPv4 address (what the kill switch lets through once the tunnel is up). */
export function wireguardTunnelAddress(config: WireguardConfig): string {
  const found = config.addresses.map((a) => a.split('/')[0]).find((a) => net.isIPv4(a));
  if (!found) throw new Error('the config has no IPv4 address');
  return found;
}

/** True when some peer sends all IPv4 traffic through the tunnel (AllowedIPs 0.0.0.0/0). */
export function routesEverything(config: WireguardConfig): boolean {
  return config.peers.some((p) => p.allowedIps.some((a) => a === '0.0.0.0/0'));
}

/** Whether `sc query` output says the tunnel service is running. */
export function serviceRunning(scOutput: string): boolean {
  return /STATE\s*:\s*\d+\s+RUNNING/i.test(scOutput);
}

/** Whether `wg show <tunnel> latest-handshakes` says a peer has completed a handshake (a time that is not 0). */
export function handshakeDone(wgOutput: string): boolean {
  return wgOutput.split(/\r?\n/).some((line) => {
    const t = /\s(\d+)\s*$/.exec(line);
    return t !== null && Number(t[1]) > 0;
  });
}
