// A headless sandbox with nothing running (or starting) only wastes RAM, so it shuts itself down.
import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { saveClaudeMem } from '../setup/claude-mem.js';
import { isWin, run } from '../runtime/paths.js';
import { log } from '../runtime/log.js';
import { session } from '../runtime/session.js';
import { live, pending, safely } from './state.js';

export const maybeShutdown = (): void => {
  if (!session.headless || !isWin) return;
  const idle = (): boolean => live.size === 0 && pending.starting === 0 && run.scanRequests().valid.length === 0;
  if (!idle()) return;
  setTimeout(() => {
    if (!idle()) return;
    log('Headless sandbox has no sessions left; shutting down.');
    safely('claude-mem save', saveClaudeMem);
    spawnSync(SYSTEM.shutdown(), ['/s', '/t', '5'], { windowsHide: true });
  }, 15000);
};
