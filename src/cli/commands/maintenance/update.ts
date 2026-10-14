import { userDir } from '../../../core/config/index.js';
import { errMsg } from '../../../core/util/index.js';
import { PACKAGE_ROOT } from '../../../core/package-info.js';
import { insideSandbox, spawnDetached } from '../../../host/sandbox/index.js';
import type { UpdateResult } from '../../../host/update/index.js';
import type { CliOptions } from '../../args.js';
import { c } from '../../output/index.js';
import { NPM_UPDATE_COMMAND, UpdateService } from '../../services/index.js';

export interface UpdateRequest {
  readonly check: boolean;
  readonly rollback: boolean;
  readonly auto?: 'on' | 'off';
  readonly unattended: boolean;
}

/** One sentence for what an update run did, and whether it counts as done. */
export function describeResult(result: UpdateResult | null, unattended: boolean): { line: string; code: number } {
  if (!result) return { line: 'Another update is running right now.', code: 0 };
  if (result.kind === 'installed')
    return {
      line:
        'Updated ' +
        (result.previous ? 'from ' + result.previous + ' ' : '') +
        'to ' +
        result.version +
        '. Open a new terminal to use it.',
      code: 0,
    };
  if (result.kind === 'failed')
    return {
      line:
        'Update to ' +
        result.version +
        ' failed: ' +
        result.reason.replace(/\.?\s*$/, '.') +
        ' Still on the version you had.' +
        (result.blocked ? ' It is not tried again; the next release is.' : ' It is tried again later.'),
      code: 1,
    };
  switch (result.reason) {
    case 'up-to-date':
      return { line: 'You have the newest version (' + result.current + ').', code: 0 };
    case 'sandbox-running':
      return {
        line: 'A Windows Sandbox is running, so nothing was installed. Close it (sandbox stop), then update again.',
        code: unattended ? 0 : 1,
      };
    case 'failed-before':
      return {
        line: 'The newest version failed to install before. It is not tried again until a newer one is released.',
        code: 0,
      };
    case 'no-release':
      return { line: 'No release was found.', code: 0 };
    case 'too-soon':
      return { line: 'Looked a short while ago; nothing to do yet.', code: 0 };
  }
}

/** `sandbox update`: the work, with the service and the output given so a test can drive it. */
export async function runUpdate(
  service: UpdateService,
  request: UpdateRequest,
  print: (line: string) => void,
): Promise<number> {
  if (!service.managed) {
    print('This copy was installed with npm. Update it with: ' + NPM_UPDATE_COMMAND);
    return 0;
  }
  if (request.auto) {
    service.setAuto(request.auto === 'on');
    print('Automatic updates are ' + request.auto + '.');
    return 0;
  }
  if (request.rollback) {
    print('Went back to version ' + service.rollback() + '.');
    return 0;
  }
  if (request.check) {
    const found = await service.check();
    if (found.available && found.latest)
      print('Version ' + found.latest.version + ' is available (you have ' + found.current + '). Run: sandbox update');
    else if (found.blocked)
      print('A newer version exists but failed to install before; you have ' + found.current + '.');
    else print('You have the newest version (' + found.current + ').');
    return 0;
  }
  const done = describeResult(await service.run(), request.unattended);
  print(done.line);
  return done.code;
}

export function update(options: CliOptions): Promise<number> {
  const service = UpdateService.forPackage(PACKAGE_ROOT, options.feed, { userDir: userDir() });
  return runUpdate(
    service,
    { check: options.check, rollback: options.rollback, auto: options.autoUpdate, unattended: options.unattended },
    (line) => console.log(line),
  );
}

/** Commands that never look for updates first: they are how updates run, or they must stay quiet. */
const NO_STARTUP_UPDATE: readonly string[] = ['self-test', 'update', '_watch'];

/**
 * At the start of a command: tells this user once about an update that ran without them, and (current-user installs
 * with automatic updates on) starts the daily check in the background. Never stops the command.
 */
export function updatesBeforeCommand(entry: string, command: string): void {
  if (insideSandbox() || NO_STARTUP_UPDATE.includes(command)) return;
  try {
    const service = UpdateService.forPackage(PACKAGE_ROOT, undefined, { userDir: userDir() });
    if (!service.managed) return;
    const notice = service.notice();
    if (notice) {
      console.error(c.dim(notice.text));
      service.markNoticeSeen(notice);
    }
    if (service.autoUpdateDue()) spawnDetached(entry, ['update', '--unattended']);
  } catch (e) {
    console.error(c.dim('Could not look for updates: ' + errMsg(e)));
  }
}
