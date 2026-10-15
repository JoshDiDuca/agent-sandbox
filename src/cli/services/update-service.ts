// Keeping the program itself up to date: the logic behind `sandbox update`, the automatic update at the start of a
// command and the Maintenance row. Only an install made by the installer (versions side by side) can update itself;
// an npm install is updated with npm. Returns data, never prints.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { errMsg, fail } from '../../core/util/index.js';
import { packageVersion } from '../../core/package-info.js';
import { InstallLayout, InstallRecordFile, UpdateTask, compareVersions } from '../../host/install/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import {
  FolderFeed,
  GithubReleases,
  UpdateLock,
  Updater,
  UpdateStateFile,
  autoOffText,
  decideUpdate,
  isTooSoon,
  updateNotice,
  type ReleaseInfo,
  type ReleaseSource,
  type UpdateNotice,
  type UpdateResult,
  type UpdateState,
} from '../../host/update/index.js';
import { JsonFile } from '../../shared/io/index.js';

/** The command for an install that is not managed (npm). */
export const NPM_UPDATE_COMMAND = 'npm install -g windows-development-sandbox';
/** How long a CLI start waits after the last look at GitHub before it looks again (current-user installs). */
const AUTO_CHECK_HOURS = 24;

export interface UpdateStatus {
  /** Installed by the installer: it can update itself. */
  readonly managed: boolean;
  readonly version: string;
  readonly scope: 'user' | 'machine' | null;
  readonly autoUpdate: boolean;
  readonly state: UpdateState;
  /** Set when a failed update was undone and switched automatic updates off: the sentence to show (menu, CLI). */
  readonly autoOffText?: string | null;
}

export interface CheckResult {
  readonly current: string;
  readonly latest: ReleaseInfo | null;
  /** A newer version exists and has not failed before. */
  readonly available: boolean;
  /** A newer version exists but failed to install; only a still newer one is tried. */
  readonly blocked: boolean;
}

/** The scheduled task, as the service needs it (a fake in tests). */
export interface UpdateTaskPort {
  register(): void;
  remove(): void;
}

export interface UpdateServiceOptions {
  readonly source?: ReleaseSource;
  readonly sandboxRunning?: () => boolean;
  readonly task?: UpdateTaskPort;
  readonly version?: string;
  /** Where this user's "already told you" marker lives. */
  readonly userDir?: string;
  readonly now?: () => Date;
}

const SeenSchema = z.object({ seen: z.string() });

/** The Windows service account the scheduled task runs as: it may not use a folder feed. */
export function runsAsSystem(env: NodeJS.ProcessEnv = process.env, username: string = os.userInfo().username): boolean {
  return username.toUpperCase() === 'SYSTEM' || (env.USERNAME ?? '').endsWith('$');
}

export class UpdateService {
  private readonly source: ReleaseSource;
  private readonly sandboxRunning: () => boolean;
  private readonly version: string;
  private readonly now: () => Date;
  private readonly task: UpdateTaskPort | null;

  constructor(
    private readonly layout: InstallLayout | null,
    private readonly options: UpdateServiceOptions = {},
  ) {
    this.source = options.source ?? new GithubReleases();
    this.sandboxRunning = options.sandboxRunning ?? isSandboxRunning;
    this.version = options.version ?? packageVersion();
    this.now = options.now ?? (() => new Date());
    // Only an all-users install has the scheduled task; a current-user install checks from the CLI start instead.
    this.task = layout?.scope === 'machine' ? (options.task ?? new UpdateTask(layout)) : null;
  }

  /** The service for the install this package runs from; `feed` is a folder with feed.json (tests, offline). */
  static forPackage(packageRoot: string, feed?: string, options: UpdateServiceOptions = {}): UpdateService {
    if (feed && runsAsSystem())
      fail('A feed folder cannot be used by the SYSTEM account.', 'Run sandbox update --feed in your own terminal.');
    return new UpdateService(InstallLayout.detect(packageRoot), {
      ...options,
      source: options.source ?? (feed ? new FolderFeed(feed) : undefined),
    });
  }

  get managed(): boolean {
    return this.layout !== null;
  }

  status(): UpdateStatus {
    const layout = this.layout;
    if (!layout)
      return { managed: false, version: this.version, scope: null, autoUpdate: false, state: {}, autoOffText: null };
    const version = layout.activeVersion() ?? this.version;
    const autoUpdate = new InstallRecordFile(layout.root).read()?.autoUpdate ?? false;
    const state = new UpdateStateFile(layout.root).read();
    return {
      managed: true,
      version,
      scope: layout.scope,
      autoUpdate,
      state,
      autoOffText: !autoUpdate && state.autoOff ? autoOffText(state.autoOff.version, version) : null,
    };
  }

  /** Asks the source what is newest. Changes nothing (the time of the look is not recorded). */
  async check(): Promise<CheckResult> {
    const layout = this.managedLayout();
    const current = layout.activeVersion() ?? this.version;
    const latest = await this.source.latest();
    const state = new UpdateStateFile(layout.root).read();
    const decision = decideUpdate({
      current,
      latest,
      state,
      now: this.now(),
      sandboxRunning: false,
      minHoursBetweenChecks: 0,
      force: true,
    });
    return {
      current,
      latest,
      available: decision.kind === 'install',
      blocked: !!latest && compareVersions(latest.version, current) > 0 && decision.kind === 'skip',
    };
  }

  /** Installs the newest version if there is one (never while a sandbox runs). null: another update is running. */
  async run(): Promise<UpdateResult | null> {
    const layout = this.managedLayout();
    this.assertCanWrite(layout);
    const release = new UpdateLock(layout.root, this.now).acquire();
    if (!release) return null;
    try {
      const updater = new Updater(layout, this.source, { now: this.now, task: this.task });
      return await updater.run({ sandboxRunning: this.sandboxRunning(), force: true });
    } finally {
      release();
    }
  }

  /** Goes back to the version the last update replaced. Returns it. */
  rollback(): string {
    const layout = this.managedLayout();
    this.assertCanWrite(layout);
    const release = new UpdateLock(layout.root, this.now).acquire();
    if (!release) fail('An update is running right now.', 'Try again in a minute.');
    try {
      return new Updater(layout, this.source, { now: this.now }).rollback();
    } finally {
      release();
    }
  }

  /**
   * Automatic updates on or off. For an all-users install this also creates or removes the scheduled task (admin
   * needed); the setting is changed only when that worked.
   */
  setAuto(on: boolean): void {
    const layout = this.managedLayout();
    this.assertCanWrite(layout);
    if (this.task) {
      if (on) this.task.register();
      else this.task.remove();
    }
    const record = new InstallRecordFile(layout.root);
    if (!record.setAutoUpdate(on))
      fail('This install has no install.json.', 'Run the installer again: it writes the file.');
    // Turned back on by the user: the "turned off by a failed update" remark is history.
    if (on) new UpdateStateFile(layout.root).update(({ autoOff: _gone, ...rest }) => rest);
  }

  /**
   * Should this CLI start update by itself? Only current-user installs (an all-users install has its scheduled task),
   * with automatic updates on, the last look at the source over a day ago, and no sandbox running.
   */
  autoUpdateDue(): boolean {
    const layout = this.layout;
    if (!layout || layout.scope !== 'user') return false;
    const status = this.status();
    return status.autoUpdate && !isTooSoon(status.state, this.now(), AUTO_CHECK_HOURS) && !this.sandboxRunning();
  }

  /** What this user has not been told yet about an update that ran without them, or null. */
  notice(): UpdateNotice | null {
    const layout = this.layout;
    if (!layout) return null;
    const seen = this.seenFile()?.read()?.seen;
    return updateNotice(new UpdateStateFile(layout.root).read(), layout.activeVersion() ?? this.version, seen);
  }

  /** Remembers that this user has been told (best effort: a failure only means the notice shows again). */
  markNoticeSeen(notice: UpdateNotice): void {
    try {
      this.seenFile()?.write({ seen: notice.key });
    } catch {
      // Nothing to do: the notice is shown once more.
    }
  }

  private seenFile(): JsonFile<z.infer<typeof SeenSchema>> | null {
    return this.options.userDir
      ? new JsonFile(SeenSchema, path.join(this.options.userDir, 'update-notice.json'))
      : null;
  }

  private managedLayout(): InstallLayout {
    return (
      this.layout ??
      fail('This copy was installed with npm, so it cannot update itself.', 'Update it with: ' + NPM_UPDATE_COMMAND)
    );
  }

  /** An all-users install lives where only administrators write: say so before anything is downloaded. */
  private assertCanWrite(layout: InstallLayout): void {
    const probe = path.join(layout.root, '.write-test-' + process.pid);
    try {
      fs.writeFileSync(probe, '');
      fs.rmSync(probe, { force: true });
    } catch (e) {
      fail(
        layout.scope === 'machine'
          ? 'This install is for everyone on this PC, so changing it needs admin rights.'
          : 'Cannot write to ' + layout.root + ': ' + errMsg(e),
        layout.scope === 'machine'
          ? 'Run this in an admin PowerShell (right-click Start > Terminal (Admin)).'
          : undefined,
      );
    }
  }
}
