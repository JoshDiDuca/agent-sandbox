// The VPN, when it is on: is the login saved and readable, can the OpenVPN download be reached. Not shown when the
// VPN is off. (That the storage folder is private is checked with the data folder.)
import { VpnLogin } from '../../../../host/vpn/index.js';
import { OPENVPN_MSI } from '../../../../shared/vpn/download.js';
import type { Check, Finding, RepairEnv } from '../types.js';
import { ok } from './common.js';

const REACH_MS = 6000;
const vpnOn = (env: RepairEnv): boolean => env.ctx.loaded.config.vpn.enabled;

export const VPN_CHECKS: Check[] = [
  {
    id: 'vpn-login',
    group: 'Network',
    name: 'VPN login',
    checking: 'the saved VPN login',
    applies: vpnOn,
    run: (env: RepairEnv): Finding => {
      const { provider } = env.ctx.loaded.config.vpn;
      const state = new VpnLogin(env.storageRoot).state(provider);
      if (state === 'saved') return ok('saved, encrypted, and this Windows user can read it');
      return state === 'none'
        ? {
            status: 'needs-you',
            detail: 'the VPN is on but no login is saved',
            means: 'The sandbox cannot start its VPN, so a launch stops.',
            fix: 'Run sandbox vpn login (or turn the VPN off: sandbox config set vpn.enabled false).',
          }
        : {
            status: 'needs-you',
            detail: 'a login is saved but this Windows user cannot decrypt it',
            means: 'It was saved by another Windows user or on another PC, so the VPN cannot start.',
            fix: 'Save it again: sandbox vpn login',
          };
    },
  },
  {
    id: 'vpn-download',
    group: 'Network',
    name: 'OpenVPN download',
    checking: 'whether the OpenVPN download can be reached',
    applies: vpnOn,
    timeoutMs: REACH_MS + 4000,
    run: async (env: RepairEnv): Promise<Finding> => {
      if (await env.system.reachable(OPENVPN_MSI.base, REACH_MS)) return ok('swupdate.openvpn.org answers');
      return {
        status: 'warn',
        detail: 'swupdate.openvpn.org did not answer within ' + REACH_MS / 1000 + ' seconds',
        means: 'The sandbox downloads OpenVPN there at its first VPN start (it is kept afterwards).',
        fix: 'Check your internet connection or proxy, then run this again.',
      };
    },
  },
];
