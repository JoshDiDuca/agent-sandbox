// What a launch needs for the VPN: the saved login, a server and its profile, the profile checked. Nothing is written
// here; generateSandbox puts the profile in the launch folder and the login in the one-shot secrets file.
import fs from 'node:fs';
import path from 'node:path';
import type { Config, PreparedVpn } from '../../core/types.js';
import { expandPath, fail } from '../../core/util/index.js';
import { assertSafeOvpn, MAX_OVPN_BYTES } from '../../shared/vpn/ovpn.js';
import {
  assertSafeWireguard,
  inspectWireguard,
  MAX_WIREGUARD_BYTES,
  renderWireguard,
} from '../../shared/vpn/wireguard.js';
import { fetchBounded, nordProfile, recommendedServer, type Fetcher } from './nordvpn.js';
import { VpnLogin } from './login.js';

export interface PrepareOptions {
  readonly config: Config;
  readonly storageRoot: string;
  /** A sandbox is running: the login is not handed to anything that is not being started now. */
  readonly sandboxRunning?: boolean;
  readonly login?: VpnLogin;
  readonly fetchText?: Fetcher;
  /** Folder a relative vpn.configFile is relative to. */
  readonly base?: string;
}

/** Null when the VPN is off. Throws a UserError that says what to do when it cannot be set up. */
export async function prepareVpn(o: PrepareOptions): Promise<PreparedVpn | null> {
  const { vpn } = o.config;
  if (!vpn.enabled) return null;
  if (!o.config.sandbox.networking)
    fail('The VPN is on, but sandbox.networking is off: there is no network to put it on.', 'Turn one of them off.');
  if (o.sandboxRunning)
    fail('A sandbox is running already, so the VPN login is not handed over.', 'Start the VPN sandbox after it stops.');
  if (vpn.provider === 'wireguard-file') return prepareWireguard(o);
  const login = o.login ?? new VpnLogin(o.storageRoot);
  const credentials =
    login.read(vpn.provider) ??
    fail(
      'The VPN is on, but no ' + (vpn.provider === 'nordvpn' ? 'NordVPN' : 'VPN') + ' login is saved.',
      'Save it with: sandbox vpn login   (or turn the VPN off: sandbox config set vpn.enabled false)',
    );
  let profile: string;
  let server: string;
  if (vpn.provider === 'nordvpn') {
    const fetchText = o.fetchText ?? fetchBounded;
    try {
      const picked = await recommendedServer(vpn.protocol, vpn.country, fetchText);
      server = picked.hostname;
      profile = await nordProfile(picked, vpn.protocol, fetchText);
    } catch (e) {
      if (e instanceof Error && e.name === 'UserError') throw e;
      fail(
        'Could not get a NordVPN server: ' + (e instanceof Error ? e.message : String(e)),
        'Check this PC is online, or turn the VPN off for now: sandbox config set vpn.enabled false',
      );
    }
  } else {
    if (!vpn.configFile.trim())
      fail(
        'vpn.provider is openvpn-file but vpn.configFile is empty.',
        'Set it: sandbox config set vpn.configFile <path>',
      );
    const file = expandPath(vpn.configFile, o.base ?? process.cwd());
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      fail('The VPN profile ' + file + ' does not exist.', 'Fix vpn.configFile.');
    if (fs.statSync(file).size > MAX_OVPN_BYTES)
      fail('The VPN profile ' + file + ' is too big.', 'Use a plain .ovpn file.');
    profile = fs.readFileSync(file, 'utf8');
    server = path.basename(file);
  }
  try {
    assertSafeOvpn(profile, server);
  } catch (e) {
    fail(
      e instanceof Error ? e.message : String(e),
      'Nothing was started. Use a profile without script or plugin lines.',
    );
  }
  return {
    session: {
      provider: vpn.provider,
      protocol: vpn.protocol,
      killSwitch: vpn.killSwitch,
      server,
      profile: 'vpn\\server.ovpn',
    },
    profile,
    credentials,
  };
}

/**
 * wireguard-file: reads vpn.configFile on this PC (size capped), checks it as untrusted data and returns it written
 * again from the checked values. It holds the private key, so it only ever goes in the one-shot secrets file. There is
 * no saved login: the keys are in the file.
 */
function prepareWireguard(o: PrepareOptions): PreparedVpn {
  const { vpn } = o.config;
  if (!vpn.configFile.trim())
    fail(
      'vpn.provider is wireguard-file but vpn.configFile is empty.',
      'Set it: sandbox config set vpn.configFile <path to your .conf>',
    );
  const file = expandPath(vpn.configFile, o.base ?? process.cwd());
  let size: number;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    return fail('The WireGuard config ' + file + ' does not exist.', 'Fix vpn.configFile.');
  }
  if (size > MAX_WIREGUARD_BYTES) fail('The WireGuard config ' + file + ' is too big.', 'Use a plain .conf file.');
  const text = fs.readFileSync(file, 'utf8');
  try {
    const config = assertSafeWireguard(text, path.basename(file));
    return {
      session: { provider: vpn.provider, protocol: 'udp', killSwitch: vpn.killSwitch, server: path.basename(file) },
      wireguardConfig: renderWireguard(config),
    };
  } catch (e) {
    return fail(
      e instanceof Error ? e.message : String(e),
      'Nothing was started. Use a config without PostUp, PreUp or other script lines.',
    );
  }
}

/** For doctor: null when vpn.configFile is a readable, safe WireGuard config, else a short reason (never a key). */
export function wireguardFileProblem(configFile: string, base: string): string | null {
  if (!configFile.trim()) return 'vpn.configFile is empty';
  const file = expandPath(configFile, base);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return file + ' is not a file';
    if (stat.size > MAX_WIREGUARD_BYTES) return file + ' is too big for a WireGuard config';
    const report = inspectWireguard(fs.readFileSync(file, 'utf8'));
    return report.ok ? null : 'refused: ' + report.problems.slice(0, 3).join('; ');
  } catch {
    return file + ' cannot be read';
  }
}

/** What the launch says about the VPN: the warnings the user must see before trusting it. */
export function vpnNotes(vpn: Config['vpn']): string[] {
  if (!vpn.enabled) return [];
  return [
    'VPN: ' +
      (vpn.provider === 'nordvpn'
        ? 'NordVPN' + (vpn.country ? ' (' + vpn.country + ')' : '')
        : vpn.provider === 'wireguard-file'
          ? 'your WireGuard config'
          : 'your profile') +
      (vpn.killSwitch
        ? ', kill switch on: if the tunnel fails the sandbox stays offline.'
        : ', kill switch OFF: if the tunnel fails the sandbox uses your normal connection.'),
    vpn.provider === 'wireguard-file'
      ? 'The agent in the sandbox can read the WireGuard private key from your config and can turn the tunnel off, because it is the administrator there. Use a key you can revoke.'
      : 'The agent in the sandbox can read the VPN login (a service login you can revoke) and can turn the tunnel off, because it is the administrator there.',
  ];
}
