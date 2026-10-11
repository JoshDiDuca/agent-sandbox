// Guest firewall: block the host's LAN (keeping DNS/DHCP to the gateway) and let the host reach session ports.
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildFirewallCommands, parseDefaultGateways, parseDnsServers } from '../../shared/netrules.js';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, isWin, log, session, warn } from '../env.js';

const ATTACH_RULE = 'AgentSandbox-Attach';

const netsh = (args: string[]): { status: number | null; out: string } => {
  const r = spawnSync(SYSTEM.netsh(), args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

const discoverExemptIps = (): string[] => {
  if (process.env.AGENT_TEST_EXEMPT) return process.env.AGENT_TEST_EXEMPT.split(',');
  if (!isWin) return [];
  const route = spawnSync(SYSTEM.route(), ['print', '-4'], { encoding: 'utf8', windowsHide: true });
  const config = spawnSync(SYSTEM.ipconfig(), ['/all'], { encoding: 'utf8', windowsHide: true });
  return [...parseDefaultGateways(route.stdout ?? ''), ...parseDnsServers(config.stdout ?? '')];
};

const internetWorks = async (): Promise<boolean> => {
  try { return (await fetch('https://nodejs.org', { method: 'HEAD', signal: AbortSignal.timeout(10000) })).status > 0; } catch { return false; }
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
  ['advfirewall', 'firewall', 'add', 'rule', 'name=' + ATTACH_RULE, 'dir=in', 'action=allow', 'enable=yes', 'profile=any', 'protocol=tcp', 'remoteip=LocalSubnet', 'program=' + ptyHostExe],
];

const run = (commands: string[][]): void => {
  for (const c of commands) {
    const r = netsh(c);
    if (r.status !== 0 && c[2] !== 'delete') throw new Error('netsh ' + c.slice(0, 5).join(' ') + ' failed (exit ' + r.status + '): ' + r.out.trim());
  }
};

/**
 * Applies the LAN block. Internet is checked first; if it works before the rules but not after, the rules (not the
 * internet) are the problem, so they are removed and the agent is told the LAN is open. If there is no internet at
 * all, the block stays in place: being offline is never a reason to open the LAN.
 */
export const applyNetworkPolicy = async (ptyHostExe: string | null): Promise<LanState> => {
  if (!session.networking) { log('Networking is disabled for this sandbox.'); return 'offline'; }
  const block = session.network.blockPrivateRanges;
  const exempt = block ? discoverExemptIps() : [];
  const lanRules = block ? buildFirewallCommands(exempt) : [];
  const commands = [...lanRules, ...(ptyHostExe && session.attach.enabled ? attachRule(ptyHostExe) : [])];
  if (!block) log('Private-range blocking disabled by config.');
  if (block) log('Gateway/DNS addresses kept reachable for DNS only: ' + (exempt.length ? [...new Set(exempt)].join(', ') : '(none found)'));
  if (!isWin || dryRun) { log('(dry run) firewall plan:'); for (const c of commands) log('  netsh ' + c.join(' ')); return block ? 'blocked' : 'open'; }
  if (commands.length === 0) return 'open';
  const online = block ? await waitForInternet(30) : true;
  run(commands);
  if (!block) return 'open';
  if (online && !(await waitForInternet(15))) {
    run(lanRules.filter((c) => c[2] === 'delete'));
    warn('The LAN block broke internet access in this sandbox, so it was removed: the agent CAN reach your local network this time. Set sandbox.networking to false for hard isolation.');
    return 'open';
  }
  if (!online) warn('No internet detected yet; the LAN block is in place anyway.');
  log('LAN blocked in the guest firewall (10/8, 172.16/12, 192.168/16, 100.64/10, link-local, multicast, IPv6 local, SMB); DNS/DHCP to the gateway allowed.');
  return 'blocked';
};

/** Guest IPv4 addresses the host can use to reach session ports. */
export const guestAddresses = (): string[] =>
  Object.values(os.networkInterfaces()).flat().filter((i): i is os.NetworkInterfaceInfo => Boolean(i) && i!.family === 'IPv4' && !i!.internal).map((i) => i.address);
