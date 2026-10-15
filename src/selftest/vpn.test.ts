// The VPN: profiles are untrusted (programs refused), the kill switch rules, NordVPN server choice, the saved login,
// the settings rules for projects, and that the login never lands in session.json or the launch folder.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../core/config/index.js';
import { applyOverrides, loosenedRequests, NEVER_LOOSER, normalizeOverrides } from '../core/local-config/index.js';
import { ConfigSchema, LocalOverridesSchema } from '../core/schema/index.js';
import { SecretStore } from '../host/secrets/index.js';
import { clearSecrets } from '../host/secrets/index.js';
import { generateSandbox } from '../host/launch/index.js';
import {
  findCountry,
  nordProfile,
  prepareVpn,
  recommendedServer,
  VpnLogin,
  vpnLine,
  vpnNotes,
} from '../host/vpn/index.js';
import { RunDir } from '../shared/channel/index.js';
import type { SecretsFile } from '../shared/channel/secrets.js';
import { OPENVPN_MSI } from '../shared/vpn/download.js';
import {
  cleanServers,
  killSwitchCommands,
  removeKillSwitchCommands,
  tunnelAddressFromLog,
  tunnelCommands,
} from '../shared/vpn/kill-switch.js';
import { assertSafeOvpn, inspectOvpn, PROGRAM_DIRECTIVES } from '../shared/vpn/ovpn.js';
import type { Suite } from './support/suite.js';

const PROFILE = [
  'client',
  'dev tun',
  'proto udp',
  'remote 185.1.2.3 1194',
  'remote-random',
  'resolv-retry infinite',
  'nobind',
  'tun-mtu 1500',
  'tun-mtu-extra 32',
  'mssfix 1450',
  'persist-key',
  'persist-tun',
  'ping 15',
  'ping-restart 0',
  'ping-timer-rem',
  'reneg-sec 0',
  'comp-lzo no',
  'remote-cert-tls server',
  'auth-user-pass',
  'verb 3',
  'pull',
  'fast-io',
  'cipher AES-256-CBC',
  'auth SHA512',
  '<ca>',
  '-----BEGIN CERTIFICATE-----',
  'MIIDxx',
  '-----END CERTIFICATE-----',
  '</ca>',
  'key-direction 1',
  '<tls-auth>',
  '-----BEGIN OpenVPN Static key V1-----',
  'abcd',
  '-----END OpenVPN Static key V1-----',
  '</tls-auth>',
  '',
].join('\r\n');

const PASSWORD = 'vpn-pass-planted-91c2d7';
const USERNAME = 'vpn-user-planted-5e8a40';

export const vpnSuite: Suite = {
  name: 'vpn',
  title: 'VPN: profile checks, kill switch rules, NordVPN, login storage, settings rules',
  run: async (t, f) => {
    t.section('a profile is untrusted data');
    const good = inspectOvpn(PROFILE);
    t.check(
      good.ok && good.remotes.length === 1 && good.remotes[0].host === '185.1.2.3' && good.remotes[0].proto === 'udp',
      'a NordVPN-style profile is accepted and says where it connects (and with which protocol)',
      JSON.stringify(good),
    );
    const byName = inspectOvpn('remote vpn.example.com 443\r\nproto tcp-client\r\nclient');
    t.check(
      byName.ok && byName.remotes[0].proto === 'tcp' && byName.remotes[0].host === 'vpn.example.com',
      'the proto line counts even after the remote line, and a host name is allowed',
    );
    for (const name of ['script-security', 'up', 'down', 'plugin', 'route-up', 'ipchange', 'tls-verify']) {
      const bad = inspectOvpn(PROFILE + name + ' 2 C:\\evil.cmd\r\n');
      t.check(
        !bad.ok && bad.problems.some((p) => p.includes(name + ' runs a program')),
        name + ' is refused as something that runs a program',
        JSON.stringify(bad),
      );
    }
    t.check(
      PROGRAM_DIRECTIVES.every((name) => !inspectOvpn(PROFILE + name + ' x\r\n').ok),
      'every listed program-running directive is refused',
    );
    const odd = [
      ['--up x', 'a leading -- does not hide it'],
      ['UP x', 'upper case does not hide it'],
      ['\tscript-security 2', 'leading white space does not hide it'],
      ['"up" x', 'quotes around the name do not hide it'],
      ['made-up-directive 1', 'an unknown directive is refused, not passed on'],
      ['ca /etc/ca.crt', 'a certificate file on this machine is refused'],
      ['auth-user-pass C:\\secret.txt', 'a login file named in the profile is refused'],
      ['setenv FOO bar', 'setenv for anything but CLIENT_CERT is refused'],
      ['<connection>', 'a <connection> section (it could hide more) is refused'],
    ] as const;
    for (const [line, why] of odd) t.check(!inspectOvpn(PROFILE + line + '\r\n').ok, why, line);
    t.check(
      !inspectOvpn(PROFILE.replace('</ca>', '')).ok &&
        !inspectOvpn('client\r\n').ok &&
        !inspectOvpn('x'.repeat(300 * 1024)).ok &&
        !inspectOvpn(PROFILE.replace('<tls-auth>', '<tls-auth>\r\nup evil\r\n<ca>')).ok,
      'an unclosed section, no remote, an oversized file and a section inside a section are refused',
    );
    t.check(
      inspectOvpn(PROFILE.replace('</ca>', '</ca>\r\n# up /bin/evil\r\n; plugin evil.dll\r\n')).ok,
      'comments are comments (a commented-out up line is not a directive)',
    );
    await t.throws(
      () => assertSafeOvpn(PROFILE + 'script-security 2\r\nup evil.cmd\r\n', 'uk1.nordvpn.com'),
      'uk1.nordvpn.com was refused',
      'a refused profile names its source and the reason',
    );

    t.section('the kill switch as netsh commands');
    const servers = [
      { ip: '185.1.2.3', port: 1194, proto: 'udp' as const },
      { ip: '185.1.2.3', port: 1194, proto: 'udp' as const },
      { ip: 'not-an-ip', port: 1194, proto: 'udp' as const },
      { ip: '185.9.9.9', port: 443, proto: 'tcp' as const },
    ];
    t.equal(
      cleanServers(servers).map((s) => s.ip + ':' + s.port),
      ['185.1.2.3:1194', '185.9.9.9:443'],
      'servers are valid and each once',
    );
    const phase1 = killSwitchCommands(servers, 'C:\\AgentLaunch\\ptyhost.exe').map((c) => c.join(' '));
    const policyAt = phase1.findIndex((c) => c.includes('firewallpolicy blockinbound,blockoutbound'));
    const firstAllow = phase1.findIndex((c) => c.includes('action=allow'));
    t.check(
      policyAt > 0 && policyAt < firstAllow,
      'outbound is blocked by default before any allow rule is added',
      phase1.join('\n'),
    );
    t.check(
      phase1.some((c) => c.includes('name=AgentSandbox-VPN-Loopback') && c.includes('remoteip=127.0.0.0/8')) &&
        phase1.some(
          (c) =>
            c.includes('name=AgentSandbox-VPN-Server-1') &&
            c.includes('protocol=udp') &&
            c.includes('remoteip=185.1.2.3') &&
            c.includes('remoteport=1194'),
        ) &&
        phase1.some(
          (c) =>
            c.includes('name=AgentSandbox-VPN-Server-2') && c.includes('protocol=tcp') && c.includes('remoteport=443'),
        ) &&
        phase1.some(
          (c) =>
            c.includes('name=AgentSandbox-VPN-Host') &&
            c.includes('remoteip=LocalSubnet') &&
            c.includes('program=C:\\AgentLaunch\\ptyhost.exe'),
        ) &&
        phase1.some((c) => c.includes('name=AgentSandbox-VPN-DHCP')),
      'it allows loopback, each VPN server endpoint, the attach channel on the Hyper-V network and DHCP',
    );
    t.check(
      !phase1.some((c) => c.includes('localip=') || (c.includes('action=allow') && c.includes('remoteip=any'))),
      'nothing else is allowed before the tunnel exists (no blanket rule)',
    );
    t.check(
      killSwitchCommands([], null).every((c) => !c.join(' ').includes('Server-1') || c[2] === 'delete') &&
        !killSwitchCommands([], null).some((c) => c.join(' ').includes('name=AgentSandbox-VPN-Host') && c[2] === 'add'),
      'with no servers and no session host only the block and the loopback rules remain (the failure case: offline)',
    );
    t.equal(
      tunnelCommands('10.8.0.6')
        .map((c) => c.join(' '))
        .filter((c) => c.includes(' add ')),
      [
        'advfirewall firewall add rule name=AgentSandbox-VPN-Tunnel dir=out action=allow enable=yes profile=any protocol=any localip=10.8.0.6',
      ],
      'once the tunnel is up, traffic from its own address (the tunnel) is allowed',
    );
    await t.throws(
      () => tunnelCommands('10.8.0.6; calc'),
      'Not an IPv4',
      'a tunnel address that is not an address makes no rule',
    );
    t.check(
      removeKillSwitchCommands().some((c) => c.join(' ').includes('blockinbound,allowoutbound')) &&
        removeKillSwitchCommands().some((c) => c.join(' ').includes('name=AgentSandbox-VPN-Tunnel')),
      'taking it away restores the default and deletes the rules',
    );
    t.equal(
      [
        tunnelAddressFromLog('... net_addr_v4_add: 10.100.0.2/16 dev Wintun ...'),
        tunnelAddressFromLog('ifconfig 10.8.0.6 255.255.255.0'),
        tunnelAddressFromLog('nothing'),
      ],
      ['10.100.0.2', '10.8.0.6', null],
      "the tunnel's address is read from OpenVPN's log",
    );
    t.check(
      OPENVPN_MSI.x64.sha256.length === 64 &&
        OPENVPN_MSI.arm64.sha256.length === 64 &&
        OPENVPN_MSI.base.startsWith('https://'),
      'the OpenVPN download has a checksum for each architecture (downloads.requireChecksum passes)',
    );

    t.section('NordVPN: the server for the country and protocol');
    const asked: string[] = [];
    const fake = (url: string): Promise<string> => {
      asked.push(url);
      if (url.endsWith('/servers/countries'))
        return Promise.resolve(
          JSON.stringify([
            { id: 227, name: 'United Kingdom', code: 'GB' },
            { id: 81, name: 'Germany', code: 'DE' },
          ]),
        );
      if (url.includes('/servers/recommendations'))
        return Promise.resolve(JSON.stringify([{ hostname: 'uk2201.nordvpn.com', station: '185.1.2.3' }]));
      if (url.endsWith('.ovpn')) return Promise.resolve(PROFILE);
      return Promise.reject(new Error('unexpected ' + url));
    };
    t.check(
      findCountry([{ id: 227, name: 'United Kingdom', code: 'GB' }], 'uk') === 227 &&
        findCountry([{ id: 81, name: 'Germany', code: 'DE' }], 'germany') === 81,
      'uk and Germany are found by code, alias or name',
    );
    await t.throws(
      () => findCountry([{ id: 81, name: 'Germany', code: 'DE' }], 'atlantis'),
      'no country',
      'an unknown country says so',
    );
    const server = await recommendedServer('udp', 'uk', fake);
    t.check(
      server.hostname === 'uk2201.nordvpn.com' &&
        asked.some((u) => u.includes('filters[country_id]=227') && u.includes('openvpn_udp')),
      'the recommendation asks for the country and the protocol',
      asked.join('\n'),
    );
    t.check(
      (await nordProfile(server, 'udp', fake)) === PROFILE &&
        asked.some(
          (u) => u === 'https://downloads.nordcdn.com/configs/files/ovpn_udp/servers/uk2201.nordvpn.com.udp.ovpn',
        ),
      "the server's own profile is fetched from NordVPN's download host",
    );
    await t.throws(
      () =>
        recommendedServer('udp', '', () =>
          Promise.resolve(JSON.stringify([{ hostname: 'evil.example.com; calc', station: '1.2.3.4' }])),
        ),
      'did not recommend',
      'an answer that is not a NordVPN host name is refused (it becomes part of a URL and a file name)',
    );

    t.section('the saved login');
    const storage = t.dir('vpn-storage');
    const login = new VpnLogin(storage, SecretStore.memory());
    t.check(login.state('nordvpn') === 'none', 'nothing is saved at first');
    await t.throws(
      () => login.save('nordvpn', { username: 'a\nb', password: 'x' }),
      'line breaks',
      'a login with a line break is refused (it goes on two lines of a file)',
    );
    login.save('nordvpn', { username: USERNAME, password: PASSWORD });
    const file = path.join(storage, 'vpn', 'nordvpn.json');
    t.check(
      login.state('nordvpn') === 'saved' &&
        !fs.readFileSync(file, 'utf8').includes(USERNAME) &&
        !fs.readFileSync(file, 'utf8').includes(PASSWORD),
      'it is saved sealed: neither value is in the file',
    );
    t.equal(login.read('nordvpn'), { username: USERNAME, password: PASSWORD }, 'and it opens for the launch');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"sealed": "[^"]*"/, '"sealed": "dpapi1:AAAA"'));
    t.check(login.state('nordvpn') === 'unreadable', 'a login this Windows user cannot open is reported as unreadable');
    login.remove('nordvpn');
    t.check(login.state('nordvpn') === 'none', 'logout deletes it');

    t.section('settings: what a project may and may not do');
    t.check(
      DEFAULTS.vpn.enabled === false && DEFAULTS.vpn.provider === 'nordvpn' && DEFAULTS.vpn.killSwitch === true,
      'the VPN is off by default, NordVPN, with the kill switch on',
    );
    t.check(ConfigSchema.safeParse(DEFAULTS).success, 'the defaults are valid');
    t.check(
      !ConfigSchema.safeParse({ ...DEFAULTS, vpn: { ...DEFAULTS.vpn, country: 'uk; calc' } }).success &&
        !ConfigSchema.safeParse({ ...DEFAULTS, vpn: { ...DEFAULTS.vpn, protocol: 'icmp' } }).success &&
        !ConfigSchema.safeParse({ ...DEFAULTS, vpn: { ...DEFAULTS.vpn, username: 'x' } }).success,
      'a country with odd characters, an unknown protocol and a login setting are all invalid (no login setting exists)',
    );
    for (const bad of [
      { vpn: { enabled: true } },
      { vpn: { provider: 'openvpn-file' } },
      { vpn: { configFile: 'C:\\evil.ovpn' } },
      { vpn: { country: 'uk' } },
      { vpn: { username: 'x', password: 'y' } },
      { vpn: { credentials: 'x' } },
      { vpn: { servers: ['1.2.3.4'] } },
    ])
      t.check(
        !LocalOverridesSchema.safeParse(bad).success,
        "a project's .sandbox-config.json cannot set " + Object.keys(bad.vpn).join(', '),
      );
    t.check(LocalOverridesSchema.safeParse({ vpn: { killSwitch: true } }).success, 'it can ask for the kill switch');
    t.check(NEVER_LOOSER.includes('vpn.killSwitch'), 'the kill switch is a protection a project may only tighten');
    const mine = structuredClone(DEFAULTS);
    mine.vpn.enabled = true;
    const loosen = normalizeOverrides({ vpn: { killSwitch: false } }, f.workA, 'x');
    t.check(
      applyOverrides(mine, loosen).vpn.killSwitch === true &&
        loosenedRequests(mine, loosen).some((r) => r.key === 'vpn.killSwitch'),
      'a project cannot turn the kill switch off (it is flagged and ignored)',
    );
    const off = structuredClone(mine);
    off.vpn.killSwitch = false;
    t.check(
      applyOverrides(off, normalizeOverrides({ vpn: { killSwitch: true } }, f.workA, 'x')).vpn.killSwitch === true,
      'but it can turn it on',
    );

    t.section('the login never lands in session.json, the launch folder or --json');
    const config = f.makeConfig();
    config.vpn = { ...config.vpn, enabled: true, country: 'uk' };
    const store = new VpnLogin(config.storage.root, SecretStore.memory());
    store.save('nordvpn', { username: USERNAME, password: PASSWORD });
    const run = await f.run({}, config);
    const prepared = await prepareVpn({
      config: run.config,
      storageRoot: config.storage.root,
      login: store,
      fetchText: fake,
    });
    t.check(
      prepared !== null &&
        prepared.session.server === 'uk2201.nordvpn.com' &&
        prepared.credentials.password === PASSWORD,
      'a launch picks the server, checks its profile and holds the login in memory',
    );
    await t.throws(
      () =>
        prepareVpn({
          config: run.config,
          storageRoot: config.storage.root,
          login: store,
          fetchText: fake,
          sandboxRunning: true,
        }),
      'already',
      'the login is not handed over while a sandbox is running (one that is not being started now)',
    );
    await t.throws(
      () =>
        prepareVpn({
          config: run.config,
          storageRoot: config.storage.root,
          login: store,
          fetchText: (url) => (url.endsWith('.ovpn') ? Promise.resolve(PROFILE + 'up evil.cmd\r\n') : fake(url)),
        }),
      'refused',
      'a profile that would run a program stops the launch before anything is written',
    );
    await t.throws(
      () =>
        prepareVpn({
          config: run.config,
          storageRoot: config.storage.root,
          login: new VpnLogin(t.dir('vpn-empty'), SecretStore.memory()),
          fetchText: fake,
        }),
      'sandbox vpn login',
      'no saved login says how to save one',
    );
    clearSecrets(config.storage.root, run.dataPath);
    const withVpn = generateSandbox({
      packageRoot: t.packageRoot,
      run,
      harnessArgs: [],
      probe: f.probe,
      pcLanguages: ['python', 'rust', 'cpp', 'dotnet'],
      ...(prepared ? { vpn: prepared } : {}),
    });
    const session = fs.readFileSync(withVpn.sessionPath, 'utf8');
    const everything: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else everything.push(fs.readFileSync(p, 'latin1'));
      }
    };
    walk(withVpn.launchPath);
    t.check(
      !session.includes(PASSWORD) &&
        !session.includes(USERNAME) &&
        !everything.some((text) => text.includes(PASSWORD) || text.includes(USERNAME)),
      'neither the service user name nor the password is in session.json or any file of the launch folder',
    );
    const vpnSession = f.readJson(withVpn.sessionPath).vpn as { server: string; killSwitch: boolean; profile: string };
    t.check(
      vpnSession.server === 'uk2201.nordvpn.com' &&
        vpnSession.killSwitch === true &&
        fs.readFileSync(path.join(withVpn.launchPath, 'vpn', 'server.ovpn'), 'utf8') === PROFILE,
      'session.json says which server and whether the kill switch is on; the checked profile is in the launch folder',
    );
    const handed = f.readJson(new RunDir(run.dataPath).secretFile(withVpn.launchId)) as SecretsFile;
    t.equal(
      handed.vpn,
      { username: USERNAME, password: PASSWORD },
      'the login is only in the one-shot file for the sandbox',
    );
    clearSecrets(config.storage.root, run.dataPath);
    t.check(
      vpnNotes(config.vpn).some((n) => n.includes('can read the VPN login') && n.includes('turn the tunnel off')) &&
        vpnNotes(config.vpn).some((n) => n.includes('kill switch on')) &&
        vpnNotes({ ...config.vpn, killSwitch: false }).some((n) => n.includes('kill switch OFF')) &&
        vpnNotes({ ...config.vpn, enabled: false }).length === 0,
      'the launch warns that the agent can read the login and turn the tunnel off, and says what the kill switch does',
    );

    t.section('what the host says about the tunnel');
    const status = (state: 'up' | 'failed' | 'starting', extra: object = {}): ReturnType<typeof vpnLine> =>
      vpnLine({ state, message: 'm', killSwitch: true, updatedAt: 'now', ...extra }, '203.0.113.9');
    t.check(
      status('up', { publicIp: '185.1.2.3', server: 'uk2201.nordvpn.com' }).level === 'ok' &&
        status('up', { publicIp: '203.0.113.9' }).level === 'bad' &&
        status('failed', { message: 'login refused' }).text.includes('NO internet') === false &&
        status('failed', { message: 'login refused' }).text.includes('no internet') &&
        vpnLine({ state: 'failed', message: 'x', killSwitch: false, updatedAt: 'now' }).text.includes(
          'normal connection',
        ) &&
        status('starting').level === 'warn',
      "up with another address is fine, up with this PC's own address is flagged, a failure says what the kill switch did",
    );
    t.check(
      !vpnLine({
        state: 'failed',
        message: 'bad \u001b]52;c;ZXZpbA==\u0007 text',
        killSwitch: true,
        updatedAt: 'n',
      }).text.includes('\u001b'),
      'text the sandbox wrote loses its escape sequences before it is printed',
    );
  },
};
