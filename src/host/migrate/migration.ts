// What a migration is: one numbered change to what is stored on this PC, with a cheap check for whether it still has to
// run and a list of what it will touch (backed up before it runs).

export type MigrationScope = 'user' | 'machine';

export interface MigrationContext {
  /** The storage root, e.g. %LOCALAPPDATA%\AgentSandbox. */
  readonly storageRoot: string;
  /** The config folder, ~/.agent-sandbox. */
  readonly userDir: string;
  /** The user's config.json, if there is one. */
  readonly configPath: string | null;
  readonly sandboxRunning: () => boolean;
}

export interface Migration {
  /** Kebab-case, unique, e.g. '2026-10-unpin-config-defaults'. */
  readonly id: string;
  /** The version the change first shipped in. */
  readonly introducedIn: string;
  readonly scope: MigrationScope;
  /** Waits while a sandbox runs (it may read the files this changes). */
  readonly needsIdleSandbox: boolean;
  /** One line: what it changes (shown by a dry run). */
  readonly summary: string;
  /** Idempotent check: is there anything to do? */
  applies(ctx: MigrationContext): boolean;
  /** Files and folders it will change; they are backed up first. */
  touches(ctx: MigrationContext): readonly string[];
  run(ctx: MigrationContext, note: (line: string) => void): Promise<void>;
}
