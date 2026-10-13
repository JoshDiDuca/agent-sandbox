// audit.processes, sandbox side: Windows records every program started (Security log, event 4688, with its command
// line); the daemon reads the new events every 15 s and leaves them in run\audit\ as small .jsonl files, which the
// host takes into its own log (and deletes). Windows' own background programs are left out. The host treats all of it
// as untrusted (it is checked line by line there).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { parseProcessEvents } from './parse.js';
import { dryRun, isWin, run } from '../runtime/paths.js';
import { log, warn } from '../runtime/log.js';
import { mkdirp } from '../runtime/fs.js';
import { session } from '../runtime/session.js';
import { errMsg } from '../../core/util/errors.js';

/** The "Process Creation" audit subcategory (a GUID, so it works in every Windows language). */
const PROCESS_CREATION = '{0CCE922B-69AE-11D9-BED3-505054503030}';
const MAX_PER_PASS = 2000;

const auditOn = (): boolean => Boolean(session.auditProcesses) && isWin && !dryRun;

/** Turns on process-creation auditing with command lines (the registry is new every boot). */
export const enableProcessAudit = (): void => {
  if (!auditOn()) return;
  spawnSync(
    path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'auditpol.exe'),
    ['/set', '/subcategory:' + PROCESS_CREATION, '/success:enable'],
    { windowsHide: true, stdio: 'ignore' },
  );
  spawnSync(
    SYSTEM.reg(),
    [
      'add',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit',
      '/v',
      'ProcessCreationIncludeCmdLine_Enabled',
      '/t',
      'REG_DWORD',
      '/d',
      '1',
      '/f',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  log('Audit: programs started in the sandbox are recorded (audit.processes).');
};

const wevtutil = (): string => path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'wevtutil.exe');
const newestRecord = (): number => {
  const r = spawnSync(wevtutil(), ['qe', 'Security', '/q:*[System[(EventID=4688)]]', '/f:xml', '/c:1', '/rd:true'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return parseProcessEvents(r.stdout ?? '').last;
};

/**
 * Reads new process events every 15 s for the daemon's life (from the moment it started: older ones are boot noise).
 */
export const startProcessCollector = (): void => {
  if (!auditOn()) return;
  let last = newestRecord();
  const pass = (): void => {
    try {
      const r = spawnSync(
        wevtutil(),
        [
          'qe',
          'Security',
          '/q:*[System[(EventID=4688) and (EventRecordID>' + last + ')]]',
          '/f:xml',
          '/c:' + MAX_PER_PASS,
        ],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      );
      const { lines, last: newest } = parseProcessEvents(r.stdout ?? '');
      if (newest) last = newest;
      if (lines.length)
        fs.writeFileSync(
          path.join(mkdirp(run.auditDir), Date.now() + '-' + process.pid + '.jsonl'),
          lines.join('\n') + '\n',
        );
    } catch (e) {
      warn('audit: ' + errMsg(e));
    }
  };
  setInterval(pass, 15000).unref?.();
};
