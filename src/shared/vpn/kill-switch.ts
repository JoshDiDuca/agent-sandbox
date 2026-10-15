// The kill switch as netsh argument lists (pure, so it is tested without a firewall). Phase 1 runs BEFORE the tunnel
// starts: everything that goes out is blocked except loopback, the VPN servers themselves, DHCP and the host's attach
// channel. Phase 2 runs once the tunnel is up: traffic from the tunnel's own address is allowed, which is everything
// that goes through the tunnel (DNS included). Windows keeps the block rules for private ranges
// (network.blockPrivateRanges) on top of this: a block rule always beats an allow rule.
import { isIPv4 } from '../network/firewall-rules.js';

export const VPN_RULE_PREFIX = 'AgentSandbox-VPN-';

export interface KillSwitchServer {
  readonly ip: string;
  readonly port: number;
  readonly proto: 'udp' | 'tcp';
}

const rule = (name: string, extra: string[]): string[] => [
  'advfirewall',
  'firewall',
  'add',
  'rule',
  'name=' + VPN_RULE_PREFIX + name,
  'dir=out',
  'action=allow',
  'enable=yes',
  'profile=any',
  ...extra,
];

const drop = (name: string): string[] => [
  'advfirewall',
  'firewall',
  'delete',
  'rule',
  'name=' + VPN_RULE_PREFIX + name,
];

/** The rule names phase 1 and 2 may create (the servers get a number each). */
export function ruleNames(serverCount: number): string[] {
  return [
    'Loopback',
    'DHCP',
    'Host',
    'Tunnel',
    ...Array.from({ length: Math.max(serverCount, 0) }, (_v, i) => 'Server-' + (i + 1)),
  ];
}

/** Servers worth a rule: valid IPv4 addresses and ports, each endpoint once. */
export function cleanServers(servers: readonly KillSwitchServer[]): KillSwitchServer[] {
  const seen = new Set<string>();
  return servers.filter((s) => {
    const key = s.proto + ':' + s.ip + ':' + s.port;
    if (!isIPv4(s.ip) || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Phase 1: block everything that goes out, then allow only what the tunnel and the attach channel need. */
export function killSwitchCommands(servers: readonly KillSwitchServer[], ptyHostExe: string | null): string[][] {
  const list = cleanServers(servers);
  return [
    ...ruleNames(Math.max(list.length, 8)).map(drop),
    ['advfirewall', 'set', 'allprofiles', 'state', 'on'],
    ['advfirewall', 'set', 'allprofiles', 'firewallpolicy', 'blockinbound,blockoutbound'],
    rule('Loopback', ['protocol=any', 'remoteip=127.0.0.0/8']),
    rule('DHCP', ['protocol=udp', 'localport=68', 'remoteport=67']),
    ...(ptyHostExe ? [rule('Host', ['protocol=any', 'remoteip=LocalSubnet', 'program=' + ptyHostExe])] : []),
    ...list.map((s, i) =>
      rule('Server-' + (i + 1), ['protocol=' + s.proto, 'remoteip=' + s.ip, 'remoteport=' + s.port]),
    ),
  ];
}

/** Phase 2: everything that leaves from the tunnel's own address goes (it is inside the tunnel). */
export function tunnelCommands(tunnelIp: string): string[][] {
  if (!isIPv4(tunnelIp)) throw new Error('Not an IPv4 address: ' + tunnelIp);
  return [drop('Tunnel'), rule('Tunnel', ['protocol=any', 'localip=' + tunnelIp])];
}

/** Takes the kill switch away again: its rules go and outbound traffic is allowed by default as before. */
export function removeKillSwitchCommands(): string[][] {
  return [
    ...ruleNames(64).map(drop),
    ['advfirewall', 'set', 'allprofiles', 'firewallpolicy', 'blockinbound,allowoutbound'],
  ];
}

/** The tunnel's own IPv4 address from OpenVPN's log (its "net_addr_v4_add" or "ifconfig" line), or null. */
export function tunnelAddressFromLog(log: string): string | null {
  const add = /net_addr_v4_add:\s*(\d{1,3}(?:\.\d{1,3}){3})\/\d+/.exec(log);
  if (add && isIPv4(add[1])) return add[1];
  const ifconfig =
    /(?:ifconfig|ip addr add|Notified TAP-Windows driver to set a DHCP IP\/netmask of)\s+(\d{1,3}(?:\.\d{1,3}){3})/i.exec(
      log,
    );
  return ifconfig && isIPv4(ifconfig[1]) ? ifconfig[1] : null;
}
