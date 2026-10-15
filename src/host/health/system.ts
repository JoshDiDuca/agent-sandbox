// What the health checks ask Windows (the processes, your PATH, the update task, folder permissions, the network). One
// interface so tests give their own answers on temp folders; the real one only reads, apart from stop().
import { spawnSync } from 'node:child_process';
import { SYSTEM, system32 } from '../../shared/system.js';
import { refuseInSelfTest } from '../test-guard.js';
import { listProcesses, type TaskRow } from '../sharing/index.js';

const HELPER_TIMEOUT_MS = 15000;
const USER_ENVIRONMENT = 'HKCU\\Environment';
const MACHINE_ENVIRONMENT = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
/** The mandatory-level SID of an elevated (admin) token. */
export const HIGH_INTEGRITY_SID = 'S-1-16-12288';
export const SHARING_GROUP = 'Agent Sandbox Users';

export interface SystemProbe {
  processes(): TaskRow[];
  pidAlive(pid: number): boolean;
  /** Ends one process (the caller has checked it is the right one). */
  stop(pid: number): void;
  /** The unexpanded PATH of this user or of the PC, or null when it cannot be read. */
  registryPath(scope: 'user' | 'machine'): string | null;
  /** Is the automatic-update task there? null when it cannot be asked. */
  updateTaskExists(): boolean | null;
  /** `icacls <folder>` output, or null. */
  icacls(dir: string): string | null;
  /** The accounts in the sharing group, or null when it cannot be read (no such group included). */
  groupMembers(): string[] | null;
  /** Is this SID in the token of this very process? null when whoami fails. */
  tokenHasGroup(sid: string): boolean | null;
  /** Does an HTTPS request to the address answer within `ms`? */
  reachable(url: string, ms: number): Promise<boolean>;
}

/** The PATH value in `reg query ... /v Path` output, or null. */
export function parseRegPath(text: string): string | null {
  const m = /^\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(text);
  return m ? m[1].trim() : null;
}

/** The accounts listed by `net localgroup <name>`: the lines between the dashes and the closing sentence. */
export function parseGroupMembers(text: string): string[] | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^-{5,}\s*$/.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim() === '' || /^\S.*\.$/.test(l.trim()));
  return rest
    .slice(0, end < 0 ? rest.length : end)
    .map((l) => l.trim())
    .filter(Boolean);
}

function run(exe: string, args: string[]): { out: string; status: number | null } {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: HELPER_TIMEOUT_MS });
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), status: r.error ? null : r.status };
}

export class WindowsProbe implements SystemProbe {
  processes(): TaskRow[] {
    return listProcesses();
  }

  pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  stop(pid: number): void {
    refuseInSelfTest('stop programs');
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('Not a process to stop: ' + pid);
    process.kill(pid);
  }

  registryPath(scope: 'user' | 'machine'): string | null {
    const r = run(SYSTEM.reg(), ['query', scope === 'user' ? USER_ENVIRONMENT : MACHINE_ENVIRONMENT, '/v', 'Path']);
    return r.status === 0 ? parseRegPath(r.out) : null;
  }

  updateTaskExists(): boolean | null {
    const r = run(system32('schtasks.exe'), ['/Query', '/TN', '\\WindowsDevelopmentSandbox\\Update']);
    return r.status === null ? null : r.status === 0;
  }

  icacls(dir: string): string | null {
    const r = run(SYSTEM.icacls(), [dir]);
    return r.status === 0 ? r.out : null;
  }

  groupMembers(): string[] | null {
    const r = run(system32('net.exe'), ['localgroup', SHARING_GROUP]);
    return r.status === 0 ? parseGroupMembers(r.out) : null;
  }

  tokenHasGroup(sid: string): boolean | null {
    const r = run(SYSTEM.whoami(), ['/groups', '/fo', 'csv', '/nh']);
    return r.status === 0 ? r.out.includes('"' + sid + '"') : null;
  }

  async reachable(url: string, ms: number): Promise<boolean> {
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(ms) });
      return response.status < 500;
    } catch {
      // Any failure (DNS, proxy, timeout) means "not reachable"; the caller words what to do.
      return false;
    }
  }
}
