// The "Data folder" row and its flow: shows where the saved data is, lets you pick another folder in the path picker,
// asks whether to move the data or only switch, and hands the command to run on the normal screen (the move prints its
// progress there).
import fs from 'node:fs';
import { humanBytes } from '../../core/disk.js';
import type { Context } from '../commands/context.js';
import {
  describeDuration,
  describeSize,
  estimate,
  holdsData,
  measureFolder,
  moveProblem,
  moveWarning,
  type Measured,
} from '../../host/storage/index.js';
import type { App } from '../tui/index.js';
import type { ShellExit } from './shell.js';

/** Measuring for the dialog stops after this long (the size then reads "at least"). */
const MEASURE_MS = 8000;

/** The row in Settings and Maintenance. */
export function dataFolderRow(ctx: Context): { label: string; hint: string; description: string } {
  return {
    label: 'Data folder',
    hint: ctx.storageRoot,
    description:
      'Where your tools, logins, history and logs are kept between sandboxes. Press Enter to move them to another folder or drive, or to use a different folder.',
  };
}

export class DataFolderFlow {
  constructor(
    private readonly app: App,
    private readonly ctx: Context,
  ) {}

  /** The command to run (move or use), or undefined when nothing was chosen. */
  async run(): Promise<ShellExit | undefined> {
    const from = this.ctx.storageRoot;
    const exists = fs.existsSync(from);
    const measured = exists ? this.measure(from) : { bytes: 0, files: 0, partial: false };
    const size = exists && holdsData(from) ? describeSize(measured) : 'nothing in it yet';
    const to = await this.app.pickPath({
      path: ['Data folder'],
      title: 'Choose the folder for your saved data',
      about: [
        'Now: ' + from + ' (' + size + ').',
        'Pick a new or empty folder to move your data there, or a folder that already holds data to use it.',
      ],
      initial: from.replace(/[\\/][^\\/]*$/, '\\'),
      use: 'use this folder',
      validate: (picked) => {
        const problem = moveProblem(from, picked, true);
        return problem ? problem.message : true;
      },
    });
    if (!to) return undefined;
    return this.decide(from, to, measured, exists);
  }

  private measure(from: string): Measured {
    const before = this.app.status;
    this.app.status = () => 'Measuring your saved data…';
    this.app.redraw();
    try {
      return measureFolder(from, MEASURE_MS);
    } finally {
      this.app.status = before;
    }
  }

  private async decide(from: string, to: string, measured: Measured, exists: boolean): Promise<ShellExit | undefined> {
    if (to.toLowerCase() === from.toLowerCase()) return undefined;
    const target = holdsData(to);
    const lines: string[] = [];
    let canMove = exists && holdsData(from) && !target;
    if (canMove) {
      const est = estimate(from, to, measured);
      lines.push('From: ' + from, 'To:   ' + to, 'Size: ' + describeSize(measured));
      lines.push(
        est.sameVolume
          ? 'Time: a few seconds (same drive, nothing is copied)'
          : 'Time: ' + describeDuration(est.seconds) + ' (copied to another drive)',
      );
      if (est.freeBytes !== null) lines.push('Free space on the target drive: ' + humanBytes(est.freeBytes));
      const warning = moveWarning(measured, est);
      if (warning) lines.push('', warning);
      if (!est.fits) canMove = false;
    } else {
      lines.push(
        target ? to + ' already holds data, so it is used as it is.' : 'There is nothing in ' + from + ' to move.',
        'Your data stays where it is.',
      );
    }
    const choice = await this.app.dialog<'move' | 'use' | 'cancel'>({
      title: canMove ? 'Move your data to ' + to + '?' : 'Use ' + to + '?',
      lines: [...lines, '', 'Use without moving: the new folder is used from now on and your old data is left behind.'],
      choices: [
        ...(canMove ? [{ value: 'move' as const, label: 'Move data', key: 'm' }] : []),
        { value: 'use' as const, label: 'Switch without moving', key: 's' },
        { value: 'cancel' as const, label: 'Cancel', key: 'c' },
      ],
      initial: 0,
      escape: 'cancel',
    });
    if (choice === 'move') return { kind: 'run', argv: ['storage', 'move', to, '--yes'] };
    if (choice === 'use') return { kind: 'run', argv: ['storage', 'use', to, '--yes'] };
    return undefined;
  }
}
