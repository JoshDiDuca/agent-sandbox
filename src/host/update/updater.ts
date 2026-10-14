// Installs a newer release next to the active one, checks that it starts (directly and through the shim), and only then
// moves the pointers to it. Any failure leaves the active version as it was and deletes what was made. A fault of the
// release itself (BadRelease) records the version as failed: it is not tried again until a newer one exists. Anything
// else (the network, a locked file) is retried by the next check. A rollback moves the pointers back.
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
/** The download's message when the bytes do not match the published sha256 (the only download failure that blocks). */
const CHECKSUM_FAILURE = /^Checksum mismatch/;

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
  /** blocked: the version is recorded as failed and not tried again until a newer one exists. */
  | { kind: 'failed'; version: string; reason: string; blocked: boolean };

/** The release itself is broken: wrong bytes, an unreadable archive, the wrong package, or it does not start. */
class BadRelease extends Error {}

/** The line of Node's crash output that says what went wrong ("Error: ..."), not the stack around it. */
const errorLine = (stderr: string): string =>
  (/^\w*Error\b.*$/m.exec(stderr)?.[0] ?? stderr.trim().split(/\r?\n/)[0] ?? '').slice(0, 200);

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
      await extractArchive(archive, work).catch((e: unknown) => {
        throw new BadRelease('The release archive could not be unpacked: ' + errMsg(e));
      });
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
      const blocked = e instanceof BadRelease;
      if (blocked) this.recordFailure(version, reason);
      else this.recordAttempt(version, false);
      return { kind: 'failed', version, reason, blocked };
    } finally {
      try {
        safeRemove(archive, path.join(this.layout.root, 'staging'));
      } catch {
        // A leftover download is replaced by the next one.
      }
    }
    this.finish(version, current);
    return { kind: 'installed', version, previous: current };
  }

  /** A release tarball: a local feed file is copied, GitHub is downloaded; either way the sha256 must match. */
  private async download(release: ReleaseInfo, archive: string): Promise<void> {
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const url = release.tarball.url;
    if (!url.startsWith('file:')) {
      await this.downloader.file(url, archive, release.tarball.sha256).catch((e: unknown) => {
        throw CHECKSUM_FAILURE.test(errMsg(e)) ? new BadRelease(errMsg(e)) : e;
      });
      return;
    }
    const from = fileURLToPath(url);
    fs.rmSync(archive, { force: true });
    fs.copyFileSync(from, archive);
    if (sha256Of(archive) !== release.tarball.sha256.toLowerCase()) {
      fs.rmSync(archive, { force: true });
      throw new BadRelease('Checksum mismatch for ' + from);
    }
  }

  /** The extracted package must be this package, at this version. Returns its commands. */
  private checkPackage(work: string, version: string): Record<string, string> {
    const file = path.join(work, 'package', 'package.json');
    if (!fs.existsSync(file)) throw new BadRelease('The release has no package/package.json.');
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new BadRelease('The release has a damaged package.json.');
    }
    const meta = PackageSchema.safeParse(json);
    if (!meta.success || meta.data.name !== PACKAGE_NAME)
      throw new BadRelease('The release is not ' + PACKAGE_NAME + '.');
    if (meta.data.version !== version)
      throw new BadRelease('The release says version ' + meta.data.version + ', but its tag is ' + version + '.');
    try {
      return readBins(json);
    } catch (e) {
      throw new BadRelease(errMsg(e));
    }
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
      throw new BadRelease(
        'Version ' +
          version +
          ' did not start' +
          (run.status !== null ? ' (exit ' + run.status + ')' : '') +
          ': ' +
          (errorLine(run.stderr || run.error?.message || '') || 'no output'),
      );
  }

  /** Through the shim, as a user runs it: the pointers now name this version. */
  private checkShim(version: string): void {
    const shim = path.join(this.layout.binDir, 'sandbox.cmd');
    // /s takes off the outer quotes, so the quoted path (Program Files has a space) needs a pair around the whole line.
    const run = spawnSync(SYSTEM.cmd(), ['/d', '/s', '/c', '""' + shim + '" --version"'], {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
      timeout: CHECK_MS,
    });
    if (run.error || run.status !== 0 || run.stdout.trim() !== version)
      throw new BadRelease(
        'The shim did not run version ' +
          version +
          ' (exit ' +
          run.status +
          '): ' +
          (errorLine(run.stderr || run.stdout || run.error?.message || '') || 'no output'),
      );
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

  /** A failed attempt that does not block the version: only the last result changes. */
  private recordAttempt(version: string, ok: boolean): void {
    const at = this.now().toISOString();
    this.state.update((s) => ({ ...s, lastResult: { version, ok, at } }));
  }

  /** The updater changes the install folder: during the self-test only a temp folder is allowed. */
  private refuseOutsideTemp(): void {
    if (testWriteRefusal(this.layout.root)) refuseInSelfTest('update the install in ' + this.layout.root);
  }
}
