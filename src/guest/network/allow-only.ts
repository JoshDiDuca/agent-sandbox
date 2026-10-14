import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { expandAllowList, PROXY_PORT } from '../../shared/network/policy.js';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, isWin, launchDir, toolsDir } from '../runtime/paths.js';
import { log } from '../runtime/log.js';
import { session } from '../runtime/session.js';
import { run } from './firewall.js';

const ALLOW_RULES = [
  'AgentSandbox-Proxy-Out',
  'AgentSandbox-DNS-Out-UDP',
  'AgentSandbox-DNS-Out-TCP',
  'AgentSandbox-DHCP-Out',
];

/** HTTP_PROXY & co. for everything in the sandbox: its own proxy (allowOnly) or yours (network.proxy). */
export function proxyEnv(): Record<string, string> {
  const own = (session.network.allowOnly ?? []).length > 0;
  const url = own ? 'http://127.0.0.1:' + PROXY_PORT : (session.network.proxy ?? '');
  if (!url) return {};
  const noProxy = 'localhost,127.0.0.1,::1';
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: noProxy, no_proxy: noProxy };
}

/**
 * network.allowOnly, after the tools are installed: the sandbox's proxy (a copy of Node named sbx-netproxy.exe, so the
 * firewall can tell it apart) is the only program allowed out, besides DNS and DHCP; Windows and browsers use it as
 * the system proxy, everything else through HTTP_PROXY. A guardrail for agents that behave: an admin in the sandbox
 * could undo it, which is why sandbox.networking false is the only hard isolation.
 */
export async function applyAllowOnly(): Promise<boolean> {
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
}
