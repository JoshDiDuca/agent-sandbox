// Programmatic API: `import { sandbox } from 'windows-development-sandbox'`. Same safety model as the CLI: the host
// only sends the request kinds the guest daemon accepts, and everything coming back is validated data.
import path from 'node:path';
import type { GuestResponse, SandboxStatus, SessionStatus } from './core/types.js';
import { attachTerminal, SandboxChannel } from './host/channel/index.js';
import { loadConfig } from './core/config/index.js';
import { RunDir } from './shared/channel/index.js';
import { isSandboxRunning } from './host/sandbox/index.js';
import { expandPath, fail } from './core/util/index.js';

export interface SandboxClient {
  /** True while a Windows Sandbox is running. */
  isRunning(): boolean;
  /** Boot status written by the sandbox (null if it never started). */
  status(): SandboxStatus | null;
  /** Waits until provisioning is finished. */
  ready(): Promise<SandboxStatus>;
  sessions(): SessionStatus[];
  /** Runs a command inside the sandbox; `cwd` is a guest path inside the workspace (default: the workspace). */
  exec(command: string[], options?: { cwd?: string; timeoutSeconds?: number }): Promise<GuestResponse>;
  /** Starts another agent session (its own terminal tab in the sandbox) and resolves once it is running. */
  startSession(options?: { harness?: string; args?: string[]; cwd?: string }): Promise<SessionStatus>;
  /** Restarts running sessions in place (they resume their conversation). */
  restart(harness?: string): Promise<GuestResponse>;
  ping(): Promise<GuestResponse>;
  /** Bridges the current terminal to a session (interactive programs only). */
  attach(sessionId?: string): Promise<number>;
}

export function sandbox(options: { config?: string } = {}): SandboxClient {
  const loaded = loadConfig(options.config);
  const dataPath = path.join(
    expandPath(loaded.config.storage.root, loaded.base),
    'data',
    loaded.config.storage.dataName,
  );
  const alive = isSandboxRunning;
  const channel = new SandboxChannel(dataPath, alive);
  // async: no sandbox is a rejected promise like every other failure, not a synchronous throw.
  const ready = async (): Promise<SandboxStatus> =>
    alive()
      ? channel.waitForReady(null)
      : fail('No Windows Sandbox is running.', 'Start one first, e.g. sandbox claude --headless.');
  return {
    isRunning: alive,
    status: () => new RunDir(dataPath).readSandboxStatus(),
    ready,
    sessions: () => new RunDir(dataPath).listSessions(),
    exec: async (command, o = {}) =>
      channel.exec(command, o.cwd ?? (await ready()).guestWorkspace, o.timeoutSeconds ?? 600),
    startSession: async (o = {}) => {
      const status = await ready();
      return channel.waitForSession(
        channel.requestSession(o.harness ?? loaded.config.defaultHarness, o.args ?? [], o.cwd ?? status.guestWorkspace),
      );
    },
    restart: async (harness) => {
      await ready();
      return channel.restart(harness ?? null);
    },
    ping: async () => {
      await ready();
      return channel.ping();
    },
    attach: async (sessionId) => {
      await ready();
      return attachTerminal(channel.pickSession(sessionId));
    },
  };
}

export type { GuestResponse, SandboxStatus, SessionStatus } from './core/types.js';
export { main } from './cli/index.js';
