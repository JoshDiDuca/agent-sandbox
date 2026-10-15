// The "VPN login" row in Settings > Network and its flow: the steps to find the NordVPN service credentials, then the
// user name and password typed with each character hidden. The login is saved encrypted and never shown again.
import type { Context } from '../commands/context.js';
import { VPN_WARNINGS } from '../commands/vpn.js';
import { NORD_STEPS, VpnService } from '../services/index.js';
import { Theme, type App } from '../tui/index.js';

/** The row's id in the settings list. */
export const VPN_LOGIN = '@vpn-login';

export function vpnLoginRow(ctx: Context): { label: string; hint: string; description: string } {
  const service = new VpnService(ctx);
  const nord = service.provider === 'nordvpn';
  if (service.provider === 'wireguard-file')
    return {
      label: 'VPN login',
      hint: 'not needed',
      description: 'A WireGuard file carries its own keys (vpn.configFile): there is no login to set.',
    };
  const state = service.loginState();
  return {
    label: nord ? 'Set NordVPN login…' : 'Set VPN login…',
    hint: state === 'saved' ? 'saved' : state === 'unreadable' ? 'cannot be read' : 'not saved',
    description:
      'The login the VPN uses (for NordVPN the service credentials from Nord Account > NordVPN > Set up NordVPN manually, not your account password). Typed hidden, kept encrypted for your Windows user, never shown. ' +
      VPN_WARNINGS.join(' '),
  };
}

export class VpnLoginFlow {
  constructor(
    private readonly app: App,
    private readonly ctx: Context,
  ) {}

  /** Returns the notice to show (undefined when cancelled). */
  async run(): Promise<string | undefined> {
    const service = new VpnService(this.ctx);
    const nord = service.provider === 'nordvpn';
    if (service.provider === 'wireguard-file') return 'A WireGuard file carries its own keys: no login is needed.';
    const path = ['Settings', 'Network', 'VPN login'];
    await this.app.message({
      path,
      title: nord ? 'NordVPN service credentials' : 'VPN login',
      lines: [
        ...(nord
          ? ['To find them:', ...NORD_STEPS.map((s, i) => i + 1 + '. ' + s)]
          : ['The user name and password your VPN profile asks for.']),
        '',
        'What you type next is hidden, kept encrypted for your Windows user and never shown again.',
        '',
        ...VPN_WARNINGS,
      ],
    });
    const username = await this.app.text({
      path,
      label: nord ? 'Service user name' : 'User name',
      masked: true,
      validate: (v) => (v.trim() ? true : 'Type the user name.'),
    });
    if (username === undefined) return undefined;
    const password = await this.app.text({
      path,
      label: nord ? 'Service password' : 'Password',
      masked: true,
      validate: (v) => (v ? true : 'Type the password.'),
    });
    if (password === undefined) return undefined;
    try {
      service.save({ username, password });
    } catch (e) {
      return Theme.error(Theme.glyph.cross + ' ' + (e instanceof Error ? e.message : String(e)));
    }
    return Theme.ok(Theme.glyph.ok + ' The VPN login is saved (encrypted). Turn the VPN on under Settings > Network.');
  }
}
