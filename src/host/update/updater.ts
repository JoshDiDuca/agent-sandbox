// Installs a newer release next to the active one, checks that it starts (directly and through the shim), and only then
// moves the pointers to it. Any failure leaves the active version as it was, records the version as failed (it is not
// tried again until a newer one exists) and deletes what was made. A rollback moves the pointers back.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { errMsg, fail } from '../../core/util/index.js';
import { Downloader, extractArchive, moveIntoPlace } from '../../shared/download/index.js';
import { SYSTEM } from '../../shared/system.js';
import { safeRemove } from '../../shared/io/index.js';
import { testWriteRefusal } from '../../shared/test-guard.js';
import { refuseInSelfTest } from '../test-guard.js';
import type { InstallLayout } from '../install/layout.js';
import { readBins, writeShims } from '../install/shims.js';
import { decideUpdate, type SkipReason } from './decision.js';
import { GithubReleases, type ReleaseInfo, type ReleaseSource } from './release-source.js';
import { UpdateStateFile } from './update-state.js';

/** The program every version must start, relative to its package folder. */
const ENTRY = 'dist/bin/sandbox.js';
const PACKAGE_NAME = 'windows-development-sandbox';
const CHECK_MS = 60 * 1000;

const PackageSchema = z.object({ name: z.string(), version: z.string() });

export interface UpdaterOptions {
  now?: () => Date;
  /** How long to wait between two looks at GitHub (not for `force`). */
  minHoursBetweenChecks?: number;
  downloader?: Downloader;
}

export interface RunOptions {
  /** A sandbox runs on this PC: its files are in use, so nothing is installed. */
  sandboxRunning: boolean;
  /** Ignores the time gate between checks. */
  force?: boolean;
}

export type UpdateResult =
  | { kind: 'skipped'; reason: SkipReason; current: string }
  | { kind: 'installed'; version: string; previous: string | null }
  | { kind: 'failed'; version: string; reason: string };

const sha256Of = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export class Updater {
  private readonly state: UpdateStateFile;
  private readonly now: () => Date;
  private readonly minHours: number;
  private readonly downloader: Downloader;

  constructor(
    private readonly layout: InstallLayout,
    private readonly source: ReleaseSource = new GithubReleases(),
    options: UpdaterOptions = {},
  ) {
    this.state = new UpdateStateFile(layout.root);
    this.now = options.now ?? (() => new Date());
    this.minHours = options.minHoursBetweenChecks ?? 24;
    this.downloader = options.downloader ?? new Downloader();
  }

  /** Looks for a newer release (unless the time gate says not yet) and installs it if it is verified. */
  async run(options: RunOptions): Promise<UpdateResult> {
    this.refuseOutsideTemp();
    const current = this.layout.activeVersion();
    const node = this.layout.activeNode();
    if (!current || !node) fail('Nothing is installed in ' + this.layout.root + ' yet.', 'Run the installer first.');
    const base = { current, state: this.state.read(), now: this.now(), minHoursBetweenChecks: this.minHours };
    const force = options.force ?? false;
    // The gates that need no network run first, so a skipped check costs nothing.
    const early = decideUpdate({ ...base, latest: null, sandboxRunning: options.sandboxRunning, force });
    if (early.kind === 'skip' && (early.reason === 'too-soon' || early.reason === 'sandbox-running'))
      return { kind: 'skipped', reason: early.reason, current };

    const latest = await this.source.latest();
    this.state.update((s) => ({ ...s, lastCheck: this.now().toISOString() }));
    const decision = decideUpdate({ ...base, latest, sandboxRunning: options.sandboxRunning, force });
    if (decision.kind === 'skip') return { kind: 'skipped', reason: decision.reason, current };
    return this.install(decision.release, current, node);
  }

  /** Points the shims back at the version the last successful update replaced. Returns that version. */
  rollback(): string {
    this.refuseOutsideTemp();
    const current = this.layout.activeVersion();
    const node = this.layout.activeNode();
    if (!current || !node) fail('Nothing is installed in ' + this.layout.root + ' yet.');
    const target = this.state.read().previous;
    if (!target)
      fail('There is no earlier version to go back to.', 'Only a version an update replaced can be restored.');
    if (!this.layout.installedVersions().includes(target))
      fail(target + ' is no longer installed.', 'Install it again with the installer.');
    this.layout.setActive(target, node);
    // The version we leave is now the one a second rollback returns to.
    this.state.update((s) => ({ ...s, previous: current }));
    return target;
  }

  private async install(release: ReleaseInfo, current: string, node: string): Promise<UpdateResult> {
    const version = release.version;
    const archive = path.join(this.layout.root, 'staging', version + '.tgz');
    const work = this.layout.versionDir(version) + '.staging';
    let activated = false;
    try {
      await this.download(release, archive);
      safeRemove(work, this.layout.versionsDir);
      await extractArchive(archive, work);
      const bins = this.checkPackage(work, version);
      moveIntoPlace(work, this.layout.versionDir(version));
      writeShims(this.layout, bins);
      this.checkEntry(version, node);
      this.layout.setActive(version, node);
      activated = true;
      this.checkShim(version);
    } catch (e) {
      const reason = errMsg(e);
      if (activated) this.layout.setActive(current, node);
      this.discard(work, version);
      this.recordFailure(version, reason);
      return { kind: 'failed', version, reason };
    } finally {
      safeRemove(archive, path.join(this.layout.root, 'staging'));
    }
    this.finish(version, current);
    return { kind: 'installed', version, previous: current };
  }

  /** A release tarball: a local feed file is copied, GitHub is downloaded; either way the sha256 must match. */
  private async download(release: ReleaseInfo, archive: string): Promise<void> {
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const url = release.tarball.url;
    if (!url.startsWith('file:')) {
      await this.downloader.file(url, archive, release.tarball.sha256);
      return;
    }
    const from = fileURLToPath(url);
    fs.rmSync(archive, { force: true });
    fs.copyFileSync(from, archive);
    if (sha256Of(archive) !== release.tarball.sha256.toLowerCase()) {
      fs.rmSync(archive, { force: true });
      throw new Error('Checksum mismatch for ' + from);
    }
  }

  /** The extracted package must be this package, at this version. Returns its commands. */
  private checkPackage(work: string, version: string): Record<string, string> {
    const file = path.join(work, 'package', 'package.json');
    if (!fs.existsSync(file)) throw new Error('The release has no package/package.json.');
    const json: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const meta = PackageSchema.safeParse(json);
    if (!meta.success || meta.data.name !== PACKAGE_NAME) throw new Error('The release is not ' + PACKAGE_NAME + '.');
    if (meta.data.version !== version)
      throw new Error('The release says version ' + meta.data.version + ', but its tag is ' + version + '.');
    return readBins(json);
  }

  /** The version starts with the private Node and prints its own version number. */
  private checkEntry(version: string, node: string): void {
    const entry = path.join(this.layout.packageDir(version), ENTRY);
    const run = spawnSync(this.layout.nodeExe(node), [entry, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: CHECK_MS,
    });
    if (run.error || run.status !== 0 || run.stdout.trim() !== version)
      throw new Error(
        'Version ' +
          version +
          ' did not start' +
          (run.status !== null ? ' (exit ' + run.status + ')' : '') +
          ': ' +
          ((run.stderr || run.error?.message || '').trim().slice(0, 300) || 'no output'),
      );
  }

  /** Through the shim, as a user runs it: the pointers now name this version. */
  private checkShim(version: string): void {
    const shim = path.join(this.layout.binDir, 'sandbox.cmd');
    const run = spawnSync(SYSTEM.cmd(), ['/d', '/s', '/c', '"' + shim + '" --version'], {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
      timeout: CHECK_MS,
    });
    if (run.error || run.status !== 0 || run.stdout.trim() !== version)
      throw new Error('The shim did not run version ' + version + ' (exit ' + run.status + ').');
  }

  /** Records the update, keeps the replaced version for a rollback and removes the rest. */
  private finish(version: string, previous: string): void {
    const at = this.now().toISOString();
    this.state.update((s) => ({ ...s, previous, lastResult: { version, ok: true, at } }));
    for (const old of this.layout.installedVersions())
      if (old !== version && old !== previous) {
        try {
          safeRemove(this.layout.versionDir(old), this.layout.versionsDir);
        } catch {
          // In use or locked: it stays until a later update.
        }
      }
  }

  private discard(work: string, version: string): void {
    for (const dir of [work, this.layout.versionDir(version)])
      try {
        safeRemove(dir, this.layout.versionsDir);
      } catch {
        // Nothing else to do: the next run starts again from the same pointers.
      }
  }

  private recordFailure(version: string, reason: string): void {
    const at = this.now().toISOString();
    this.state.update((s) => ({ ...s, failed: { version, at, reason }, lastResult: { version, ok: false, at } }));
  }

  /** The updater changes the install folder: during the self-test only a temp folder is allowed. */
  private refuseOutsideTemp(): void {
    if (testWriteRefusal(this.layout.root)) refuseInSelfTest('update the install in ' + this.layout.root);
  }
}
