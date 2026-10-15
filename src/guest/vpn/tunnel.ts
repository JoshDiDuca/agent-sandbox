// Starts OpenVPN with the login in a file that exists only while it connects, waits for the tunnel, and reports. The
// file is deleted as soon as the tunnel is up (or has failed). OpenVPN reads it again when it must log in again, so a
// tunnel that drops does not come back on its own (the kill switch then keeps the sandbox offline): the sandbox's
// login is not left on disk for that.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tunnelAddressFromLog } from '../../shared/vpn/kill-switch.js';
import { logsDir } from '../runtime/paths.js';
import { log } from '../runtime/log.js';

export interface TunnelOutcome {
  readonly ok: boolean;
  readonly message: string;
  /** The tunnel's own address (what the kill switch lets through). */
  readonly tunnelIp?: string;
}

export interface TunnelOptions {
  readonly exe: string;
  readonly profile: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs?: number;
}

const DONE = 'Initialization Sequence Completed';

/** Why the log says OpenVPN stopped, in a short plain sentence (or null when it does not say). */
export function failureReason(text: string): string | null {
  if (/AUTH_FAILED/i.test(text))
    return 'the VPN refused the login (for NordVPN use the service credentials, not your account password)';
  if (/TLS Error: TLS key negotiation failed|TLS handshake failed/i.test(text))
    return 'it could not reach the VPN server (the network blocks it, or the server is down)';
  if (
    /All wintun adapters on this system are in use|Cannot open TUN\/TAP|Could not create Wintun|ovpn-dco.*(error|failed)/i.test(
      text,
    )
  )
    return 'the network driver for the tunnel could not be used';
  if (/Exiting due to fatal error/i.test(text)) return 'OpenVPN stopped with an error';
  return null;
}

const tail = (text: string, lines = 12): string => text.trim().split(/\r?\n/).slice(-lines).join('\n');

/** Connects. Never leaves the login on disk; kills OpenVPN when the tunnel does not come up in time. */
export async function startTunnel(o: TunnelOptions): Promise<TunnelOutcome> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vpn-'));
  const auth = path.join(dir, 'login.txt');
  const logFile = path.join(dir, 'openvpn.log');
  const keepLog = (): void => {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.copyFileSync(logFile, path.join(logsDir, 'openvpn.log'));
    } catch {
      // The log is only for finding out what went wrong.
    }
  };
  fs.writeFileSync(auth, o.username + '\r\n' + o.password + '\r\n', 'utf8');
  try {
    const child = spawn(
      o.exe,
      ['--config', o.profile, '--auth-user-pass', auth, '--auth-nocache', '--verb', '3', '--log', logFile],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    let exited: number | null = null;
    child.once('exit', (code) => {
      exited = code ?? -1;
    });
    child.once('error', (e) => {
      exited = -1;
      log('VPN: could not start OpenVPN: ' + e.message);
    });
    child.unref();
    const deadline = Date.now() + (o.timeoutMs ?? 90000);
    for (;;) {
      const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      if (text.includes(DONE)) {
        keepLog();
        const tunnelIp = tunnelAddressFromLog(text) ?? undefined;
        return { ok: true, message: 'the tunnel is up', ...(tunnelIp ? { tunnelIp } : {}) };
      }
      const reason = failureReason(text);
      if (exited !== null || reason) {
        if (exited === null) child.kill();
        keepLog();
        return { ok: false, message: (reason ?? 'OpenVPN stopped') + '. ' + tail(text, 4) };
      }
      if (Date.now() > deadline) {
        child.kill();
        keepLog();
        return { ok: false, message: 'the tunnel did not come up in time. ' + tail(text, 4) };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    fs.rmSync(auth, { force: true });
  }
}
