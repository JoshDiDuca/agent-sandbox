// Guest firewall: block the host's LAN (keeping DNS/DHCP to the gateway) and let the host reach session ports.
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildFirewallCommands, parseDefaultGateways, parseDnsServers } from '../../shared/netrules.js';
import { dryRun, isWin, log, session } from '../env.js';

const ATTACH_RULE = 'AgentSandbox-Attach';

const netsh = (args: string[]): { status: number | null; out: string } => {
  const r = spawnSync('netsh', args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

const discoverExemptIps = (): string[] => {
  if (process.env.AGENT_TEST_EXEMPT) return process.env.AGENT_TEST_EXEMPT.split(',');
  if (!isWin) return [];
  const route = spawnSync('route', ['print', '-4'], { encoding: 'utf8', windowsHide: true });
  const config = spawnSync('ipconfig', ['/all'], { encoding: 'utf8', windowsHide: true });
  return [...parseDefaultGateways(route.stdout ?? ''), ...parseDnsServers(config.stdout ?? '')];
};

const internetWorks = async (): Promise<boolean> => {
  try { return (await fetch('https://nodejs.org', { method: 'HEAD', signal: AbortSignal.timeout(10000) })).status > 0; } catch { return false; }
};

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

export const applyNetworkPolicy = async (ptyHostExe: string | null): Promise<void> => {
  if (!session.networking) { log('Networking is disabled for this sandbox.'); return; }
  const block = session.network.blockPrivateRanges;
  const exempt = block ? discoverExemptIps() : [];
  const lanRules = block ? buildFirewallCommands(exempt) : [];
  const commands = [...lanRules, ...(ptyHostExe && session.attach.enabled ? attachRule(ptyHostExe) : [])];
  if (!block) log('Private-range blocking disabled by config.');
  if (block) log('Gateway/DNS addresses kept reachable for DNS only: ' + (exempt.length ? [...new Set(exempt)].join(', ') : '(none found)'));
  if (commands.length === 0) return;
  if (!isWin || dryRun) { log('(dry run) firewall plan:'); for (const c of commands) log('  netsh ' + c.join(' ')); return; }
  run(commands);
  if (!block) return;
  if (!(await internetWorks())) {
    run(lanRules.filter((c) => c[2] === 'delete'));
    throw new Error('Internet check failed after applying the private-range block, so the rules were removed again.');
  }
  log('LAN blocked in the guest firewall (10/8, 172.16/12, 192.168/16, link-local, multicast, IPv6 local, SMB); DNS/DHCP to the gateway allowed.');
};

/** Guest IPv4 addresses the host can use to reach session ports. */
export const guestAddresses = (): string[] =>
  Object.values(os.networkInterfaces()).flat().filter((i): i is os.NetworkInterfaceInfo => Boolean(i) && i!.family === 'IPv4' && !i!.internal).map((i) => i.address);
