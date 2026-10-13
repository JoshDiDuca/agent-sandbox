// Network rules: which addresses the sandbox may reach (LAN block with the gateway and DNS kept), reading the
// gateway/DNS from Windows output, and which addresses count as "the sandbox" for attach.
import os from 'node:os';
import { isSandboxAddress } from '../host/attach.js';
import {
  buildFirewallCommands,
  cidrToRange,
  ipv4DnsServers,
  parseDefaultGateways,
  parseDnsServers,
  subtractIps,
} from '../shared/netrules.js';
import { expandAllowList, hostAllowed, withBlockedHosts } from '../shared/netpolicy.js';
import type { Suite } from './suite.js';

export const networkSuite: Suite = {
  name: 'network',
  title: 'firewall maths, gateway/DNS parsing, attach address checks',
  run: (t) => {
    t.section('firewall');
    const [start172, end172] = cidrToRange('172.16.0.0/12');
    const gateway = 172 * 16777216 + 28 * 65536 + 1;
    const remaining = subtractIps([[start172, end172]], ['172.28.0.1']);
    t.check(
      remaining.every(([start, end]) => gateway < start || gateway > end),
      'the private block minus the gateway no longer contains the gateway',
    );
    t.excludes(
      buildFirewallCommands(['8.8.8.8']).join(),
      '8.8.8.8',
      'public addresses are not part of the private-range rules',
    );

    t.section('reading Windows output');
    t.equal(
      parseDefaultGateways('  0.0.0.0          0.0.0.0     172.28.80.1   172.28.85.200     5\n'),
      ['172.28.80.1'],
      'the default gateway is read from the route table',
    );
    t.equal(
      parseDnsServers('   DNS Servers . . . : 172.28.80.1\n                       8.8.8.8\n   NetBIOS : x\n'),
      ['172.28.80.1', '8.8.8.8'],
      'DNS servers are read from ipconfig output',
    );
    t.equal(
      ipv4DnsServers(['172.28.80.1', '8.8.8.8:1053', '[::1]:53', 'fe80::1']),
      ['172.28.80.1', '8.8.8.8'],
      'DNS servers from the resolver (any Windows language): IPv4 only, ports dropped',
    );

    t.section('attach only reaches into the sandbox');
    const interfaces = {
      'vEthernet (Default Switch)': [
        { address: '172.20.0.1', netmask: '255.255.240.0', family: 'IPv4', internal: false, mac: '', cidr: null },
      ],
      'vEthernet (WSL (Hyper-V firewall))': [
        { address: '172.30.0.1', netmask: '255.255.240.0', family: 'IPv4', internal: false, mac: '', cidr: null },
      ],
      Ethernet: [
        { address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null },
      ],
    } as unknown as ReturnType<typeof os.networkInterfaces>;
    t.check(isSandboxAddress('172.20.5.9', interfaces), 'an address in the Hyper-V subnet is the sandbox');
    t.check(!isSandboxAddress('192.168.1.20', interfaces), 'a LAN address is not');
    t.check(
      !isSandboxAddress('172.30.4.4', interfaces),
      'an address on the WSL Hyper-V network is not (keystrokes never go to a WSL VM)',
    );
    t.check(!isSandboxAddress('127.0.0.1', interfaces), 'loopback is not');
    t.check(!isSandboxAddress('8.8.8.8', interfaces), 'an internet address is not');
    t.check(!isSandboxAddress('172.20.0.1', interfaces), "this PC's own address on that subnet is not");

    t.section('network settings');
    const allow = expandAllowList(['@developer', 'Example.COM', '*.corp.example', 'not a host!']);
    t.check(
      allow.includes('registry.npmjs.org') &&
        allow.includes('api.anthropic.com') &&
        allow.includes('example.com') &&
        !allow.includes('not a host!'),
      'allowOnly: @developer expands to registries, GitHub and AI providers; bad entries are dropped',
    );
    t.equal(
      ['a.corp.example', 'corp.example', 'example.com', 'www.example.com', 'evil-example.com'].map((h) =>
        hostAllowed(h, allow),
      ),
      [true, false, true, false, false],
      'allowOnly: *.x covers subdomains only, a name covers only itself',
    );
    const hosts = '127.0.0.1 localhost\r\n# mine\r\n';
    const once = withBlockedHosts(hosts, ['Telemetry.Example.com', '*.bad']);
    t.check(
      once.includes('0.0.0.0 telemetry.example.com') && once.includes('# mine') && !once.includes('*.bad'),
      'blockHosts: names go to 0.0.0.0, your own lines stay, wildcards are skipped (a hosts file cannot do them)',
    );
    t.equal(withBlockedHosts(once, ['telemetry.example.com']), once, 'blockHosts: applying again changes nothing');
    t.check(!withBlockedHosts(once, []).includes('telemetry'), 'blockHosts: an empty list removes the section');
  },
};
