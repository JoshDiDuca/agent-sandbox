// Saved logins: the logic behind `sandbox account` and the menu. Returns data, never prints.
import {
  AccountStore,
  type Account,
  type AccountRow,
  hostClaudeDir,
  hostGlobalStateFile,
} from '../../host/profile/index.js';
import { SandboxChannel } from '../../host/channel/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import type { Context } from '../commands/context.js';

export type AccountsContext = Pick<Context, 'storageRoot' | 'dataPath' | 'loaded'>;

export class AccountsService {
  private readonly store: AccountStore;

  constructor(private readonly ctx: AccountsContext) {
    this.store = new AccountStore(ctx.storageRoot);
  }

  list(): AccountRow[] {
    return this.store.list(this.ctx.dataPath);
  }

  /** Name of the login the sandbox uses now, if any. */
  activeName(): string | null {
    return this.store.activeFor(this.ctx.dataPath);
  }

  /** Saves the sandbox's login, or this PC's when fromHost. */
  save(name: string, fromHost: boolean): Account {
    return this.store.save(this.ctx.dataPath, name, fromHost ? this.hostLogin() : null);
  }

  /** Makes the sandbox use a saved login. Running sessions keep the old one until restartClaude(). */
  activate(name: string): Account {
    return this.store.activate(this.ctx.dataPath, name);
  }

  /** Whether a Claude session is running in the sandbox that would pick up a new login on restart. */
  hasRunningClaude(): boolean {
    return (
      isSandboxRunning() && new SandboxChannel(this.ctx.dataPath).runningSessions().some((s) => s.harness === 'claude')
    );
  }

  /** Restarts the running Claude sessions (conversations continue); returns the sandbox's own message. */
  async restartClaude(): Promise<string> {
    return (await new SandboxChannel(this.ctx.dataPath).restart('claude')).message;
  }

  setDefault(name: string): void {
    this.store.setDefault(name);
  }

  remove(name: string): void {
    this.store.remove(name);
  }

  /** This PC's Claude login location (config folder + global state file). */
  private hostLogin(): { claudeDir: string; globalStateFile: string } {
    const profile = this.ctx.loaded.config.claudeProfile;
    return { claudeDir: hostClaudeDir(profile), globalStateFile: hostGlobalStateFile(profile) };
  }
}
