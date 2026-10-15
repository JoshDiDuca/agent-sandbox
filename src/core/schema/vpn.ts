// The VPN setting (inside the sandbox only; the login is not a setting: it is kept encrypted by `sandbox vpn login`).
import { z } from 'zod';

export const VPN_PROVIDERS = ['nordvpn', 'openvpn-file'] as const;

export const VpnSchema = z.strictObject({
  enabled: z
    .boolean()
    .describe(
      "Send the sandbox's traffic through a VPN. Only the sandbox: your PC's own connection is untouched. Needs a saved login first (sandbox vpn login). The agent in the sandbox can read that login and can turn the tunnel off (it is the administrator there).",
    ),
  provider: z
    .enum(VPN_PROVIDERS)
    .describe(
      'nordvpn: a recommended NordVPN server is picked at every launch. openvpn-file: your own .ovpn file (configFile).',
    ),
  protocol: z.enum(['udp', 'tcp']).describe('udp is faster; tcp gets through networks that block udp.'),
  country: z
    .string()
    .regex(/^([A-Za-z][A-Za-z .'-]{0,39})?$/, 'a country name or code like uk or Germany')
    .describe('nordvpn: the country of the server, e.g. uk, us or Germany. Empty = the best server anywhere.'),
  configFile: z
    .string()
    .describe(
      "openvpn-file: the .ovpn file on this PC (its certificates inside it). Files that run programs (script-security, up, down, plugin ...) are refused. A project's file can never set this.",
    ),
  killSwitch: z
    .boolean()
    .describe(
      'Block all traffic that does not go through the tunnel: when the tunnel cannot start, the sandbox stays offline instead of using your normal connection. A project can only turn this on, never off.',
    ),
});

export type VpnProvider = (typeof VPN_PROVIDERS)[number];
