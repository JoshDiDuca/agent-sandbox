// What the VPN commands and the menu need: your settings, whether a login is saved, the running sandbox's tunnel.
// No printing here, and the login is never returned: only saved, unreadable or none.
import type { Config } from '../../core/types.js';
import type { VpnProvider } from '../../core/schema/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import {
  hostPublicIp,
  readVpnLine,
  VpnLogin,
  type LoginState,
  type VpnCredentials,
  type VpnLine,
} from '../../host/vpn/index.js';
import type { Context } from '../commands/context.js';

export interface VpnReport {
  readonly enabled: boolean;
  readonly provider: VpnProvider;
  readonly protocol: Config['vpn']['protocol'];
  readonly country: string;
  readonly killSwitch: boolean;
  readonly login: LoginState;
  readonly loginSavedAt: string | null;
  /** The running sandbox's tunnel, when one runs with the VPN on. */
  readonly running: VpnLine | null;
}

/** The steps to get the NordVPN service credentials, in the words of Nord Account (shown before asking). */
export const NORD_STEPS: readonly string[] = [
  'Sign in at https://my.nordaccount.com with your usual NordVPN e-mail and password.',
  'Open NordVPN, then "Set up NordVPN manually" (under Advanced settings).',
  'Verify your e-mail if it asks, then copy the "Service credentials": a user name and a password.',
  'These are NOT your account password. You can revoke them in the same place whenever you like.',
];

export class VpnService {
  private readonly login: VpnLogin;

  constructor(private readonly ctx: Context) {
    this.login = new VpnLogin(ctx.storageRoot);
  }

  private get config(): Config['vpn'] {
    return this.ctx.loaded.config.vpn;
  }

  get provider(): VpnProvider {
    return this.config.provider;
  }

  async report(): Promise<VpnReport> {
    const c = this.config;
    const running = isSandboxRunning();
    return {
      enabled: c.enabled,
      provider: c.provider,
      protocol: c.protocol,
      country: c.country,
      killSwitch: c.killSwitch,
      login: this.login.state(c.provider),
      loginSavedAt: this.login.savedAt(c.provider),
      running: running ? readVpnLine(this.ctx.dataPath, await hostPublicIp()) : null,
    };
  }

  loginState(): LoginState {
    return this.login.state(this.provider);
  }

  save(credentials: VpnCredentials): void {
    this.login.save(this.provider, credentials);
  }

  remove(): boolean {
    return this.login.remove(this.provider);
  }
}
