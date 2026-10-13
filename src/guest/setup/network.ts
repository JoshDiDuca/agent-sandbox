// Guest firewall: block the host's LAN (keeping DNS/DHCP to the gateway) and let the host reach session ports.
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { expandAllowList, PROXY_PORT, relayPort, withBlockedHosts } from '../../shared/network/policy.js';
import {
  buildFirewallCommands,
  ipv4DnsServers,
  isIPv4,
  parseDefaultGateways,
  parseDnsServers,
} from '../../shared/network/firewall-rules.js';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, errMsg, isWin, launchDir, log, session, toolsDir, warn } from '../env.js';

const ATTACH_RULE = 'AgentSandbox-Attach';

const netsh = (args: string[]): { status: number | null; out: string } => {
  const r = spawnSync(SYSTEM.netsh(), args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

const discoverExemptIps = (): string[] => {
  if (process.env.AGENT_TEST_EXEMPT) return process.env.AGENT_TEST_EXEMPT.split(',');
  if (!isWin) return [];
  const route = spawnSync(SYSTEM.route(), ['print', '-4'], { encoding: 'utf8', windowsHide: true });
  // The resolver's own list works on every Windows language; `ipconfig /all` (English labels only) is the fallback.
  let servers: string[] = [];
  try {
    servers = ipv4DnsServers(dns.getServers());
  } catch {
    /* fall back below */
  }
  if (!servers.length)
    servers = parseDnsServers(
      spawnSync(SYSTEM.ipconfig(), ['/all'], { encoding: 'utf8', windowsHide: true }).stdout ?? '',
    );
  return [...parseDefaultGateways(route.stdout ?? ''), ...servers];
};

const internetWorks = async (): Promise<boolean> => {
  try {
    return (await fetch('https://nodejs.org', { method: 'HEAD', signal: AbortSignal.timeout(10000) })).status > 0;
  } catch {
    return false;
  }
};

/** The sandbox network can take a few seconds to come up after logon. */
const waitForInternet = async (seconds: number): Promise<boolean> => {
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    if (await internetWorks()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
};

/** What the agent's manifest says about the LAN. */
export type LanState = 'blocked' | 'open' | 'offline';

/** Inbound rule for ptyhost only, and only from the sandbox's own subnet (where the host's Hyper-V adapter is). */
const attachRule = (ptyHostExe: string): string[][] => [
  ['advfirewall', 'firewall', 'delete', 'rule', 'name=' + ATTACH_RULE],
  [
    'advfirewall',
    'firewall',
    'add',
    'rule',
    'name=' + ATTACH_RULE,
    'dir=in',
    'action=allow',
    'enable=yes',
    'profile=any',
    'protocol=tcp',
    'remoteip=LocalSubnet',
    'program=' + ptyHostExe,
  ],
];

const run = (commands: string[][]): void => {
  for (const c of commands) {
    const r = netsh(c);
    if (r.status !== 0 && c[2] !== 'delete')
      throw new Error('netsh ' + c.slice(0, 5).join(' ') + ' failed (exit ' + r.status + '): ' + r.out.trim());
  }
};

/**
 * Applies the LAN block. Internet is checked first; if it works before the rules but not after, the rules (not the
 * internet) are the problem, so they are removed and the agent is told the LAN is open. If there is no internet at
 * all, the block stays in place: being offline is never a reason to open the LAN.
 */
export const applyNetworkPolicy = async (ptyHostExe: string | null): Promise<LanState> => {
  if (!session.networking) {
    log('Networking is disabled for this sandbox.');
    return 'offline';
  }
  const block = session.network.blockPrivateRanges;
  const exempt = block ? discoverExemptIps() : [];
  const lanRules = block ? buildFirewallCommands(exempt) : [];
  const commands = [
    ...lanRules,
    ...(ptyHostExe && session.attach.enabled ? attachRule(ptyHostExe) : []),
    ...forwardRule(),
  ];
  if (isWin && !dryRun) {
    try {
      applyBlockedHosts();
    } catch (e) {
      warn('network.blockHosts could not be applied: ' + errMsg(e));
    }
    try {
      applyDns();
    } catch (e) {
      warn('network.dns could not be applied: ' + errMsg(e));
    }
  }
  if (!block) log('Private-range blocking disabled by config.');
  if (block)
    log(
      'Gateway/DNS addresses kept reachable for DNS only: ' +
        (exempt.length ? [...new Set(exempt)].join(', ') : '(none found)'),
    );
  if (!isWin || dryRun) {
    log('(dry run) firewall plan:');
    for (const c of commands) log('  netsh ' + c.join(' '));
    return block ? 'blocked' : 'open';
  }
  if (commands.length === 0) return 'open';
  const online = block ? await waitForInternet(30) : true;
  run(commands);
  if (!block) return 'open';
  if (online && !(await waitForInternet(15))) {
    run(lanRules.filter((c) => c[2] === 'delete'));
    warn(
      'The LAN block broke internet access in this sandbox, so it was removed: the agent CAN reach your local network this time. Set sandbox.networking to false for hard isolation.',
    );
    return 'open';
  }
  if (!online) warn('No internet detected yet; the LAN block is in place anyway.');
  log(
    'LAN blocked in the guest firewall (10/8, 172.16/12, 192.168/16, 100.64/10, link-local, multicast, IPv6 local, SMB); DNS/DHCP to the gateway allowed.',
  );
  return 'blocked';
};

// ---- the rest of the network settings -----------------------------------------------------------------------------

const FORWARD_RULE = 'AgentSandbox-Forward';
const ALLOW_RULES = [
  'AgentSandbox-Proxy-Out',
  'AgentSandbox-DNS-Out-UDP',
  'AgentSandbox-DNS-Out-TCP',
  'AgentSandbox-DHCP-Out',
];
const HOSTS_FILE = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');

/** network.blockHosts: those names go nowhere (the sandbox's hosts file; the registry and files are new every boot). */
const applyBlockedHosts = (): void => {
  const hosts = session.network.blockHosts ?? [];
  if (!hosts.length) return;
  const text = fs.existsSync(HOSTS_FILE) ? fs.readFileSync(HOSTS_FILE, 'utf8') : '';
  fs.writeFileSync(HOSTS_FILE, withBlockedHosts(text, hosts));
  log('Blocked hosts (network.blockHosts): ' + hosts.join(', '));
};

/** network.dns: these servers on every connected adapter. */
const applyDns = (): void => {
  const servers = (session.network.dns ?? []).filter(isIPv4);
  if (!servers.length) return;
  const r = spawnSync(
    SYSTEM.powershell(),
    [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      "Get-NetAdapter | Where-Object Status -eq 'Up' | Set-DnsClientServerAddress -ServerAddresses " +
        servers.map((s) => "'" + s + "'").join(','),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status !== 0) throw new Error('could not set the DNS servers: ' + (r.stderr ?? '').trim().slice(0, 300));
  log('DNS servers (network.dns): ' + servers.join(', '));
};

/** network.forwardPorts: the relays (in the daemon) take connections from the PC only, i.e. the sandbox's own subnet. */
const forwardRule = (): string[][] => {
  const forwards = session.network.forwardPorts ?? [];
  return forwards.length
    ? [
        ['advfirewall', 'firewall', 'delete', 'rule', 'name=' + FORWARD_RULE],
        [
          'advfirewall',
          'firewall',
          'add',
          'rule',
          'name=' + FORWARD_RULE,
          'dir=in',
          'action=allow',
          'enable=yes',
          'profile=any',
          'protocol=tcp',
          'remoteip=LocalSubnet',
          'localport=' + forwards.map((_f, i) => relayPort(i)).join(','),
        ],
      ]
    : [];
};

/** HTTP_PROXY & co. for everything in the sandbox: its own proxy (allowOnly) or yours (network.proxy). */
export const proxyEnv = (): Record<string, string> => {
  const own = (session.network.allowOnly ?? []).length > 0;
  const url = own ? 'http://127.0.0.1:' + PROXY_PORT : (session.network.proxy ?? '');
  if (!url) return {};
  const noProxy = 'localhost,127.0.0.1,::1';
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: noProxy, no_proxy: noProxy };
};

/**
 * network.allowOnly, after the tools are installed: the sandbox's proxy (a copy of Node named sbx-netproxy.exe, so the
 * firewall can tell it apart) is the only program allowed out, besides DNS and DHCP; Windows and browsers use it as
 * the system proxy, everything else through HTTP_PROXY. A guardrail for agents that behave: an admin in the sandbox
 * could undo it, which is why sandbox.networking false is the only hard isolation.
 */
export const applyAllowOnly = async (): Promise<boolean> => {
  const hosts = session.network.allowOnly ?? [];
  if (!session.networking || !hosts.length) return false;
  if (!isWin || dryRun) {
    log('(dry run) would allow only: ' + hosts.join(', '));
    return false;
  }
  const exe = path.join(toolsDir, 'netproxy', 'sbx-netproxy.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  if (!fs.existsSync(exe) || fs.statSync(exe).size !== fs.statSync(process.execPath).size)
    fs.copyFileSync(process.execPath, exe);
  spawn(exe, [path.join(launchDir, 'runtime', 'netproxy.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  const add = (name: string, extra: string[]): string[] => [
    'advfirewall',
    'firewall',
    'add',
    'rule',
    'name=' + name,
    'dir=out',
    'action=allow',
    'enable=yes',
    'profile=any',
    ...extra,
  ];
  run([
    ...ALLOW_RULES.map((n) => ['advfirewall', 'firewall', 'delete', 'rule', 'name=' + n]),
    add('AgentSandbox-Proxy-Out', ['program=' + exe]),
    add('AgentSandbox-DNS-Out-UDP', ['protocol=udp', 'remoteport=53']),
    add('AgentSandbox-DNS-Out-TCP', ['protocol=tcp', 'remoteport=53']),
    add('AgentSandbox-DHCP-Out', ['protocol=udp', 'remoteport=67', 'localport=68']),
    ['advfirewall', 'set', 'allprofiles', 'firewallpolicy', 'blockinbound,blockoutbound'],
    ['winhttp', 'set', 'proxy', '127.0.0.1:' + PROXY_PORT, '<local>'],
  ]);
  const internet = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  for (const [name, type, value] of [
    ['ProxyEnable', 'REG_DWORD', '1'],
    ['ProxyServer', 'REG_SZ', '127.0.0.1:' + PROXY_PORT],
    ['ProxyOverride', 'REG_SZ', '<local>'],
  ]) {
    spawnSync(SYSTEM.reg(), ['add', internet, '/v', name, '/t', type, '/d', value, '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  }
  log(
    'Only these hosts can be reached now (network.allowOnly): ' +
      expandAllowList(hosts).join(', ') +
      '. Refused ones are listed in logs\\netproxy.log.',
  );
  return true;
};

/** Guest IPv4 addresses the host can use to reach session ports. */
export const guestAddresses = (): string[] =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => Boolean(i) && i!.family === 'IPv4' && !i!.internal)
    .map((i) => i.address);
