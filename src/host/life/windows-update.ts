import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { isWin } from '../../core/util/index.js';

// ---- Windows Update and keeping awake ----------------------------------------------------------------------------

/** Windows has installed updates and waits to restart: it may do so on its own, outside your active hours. */
export const updateRestartPending = (): boolean =>
  isWin &&
  [
    'HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\Auto Update\\RebootRequired',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending',
  ].some(
    (key) =>
      spawnSync(SYSTEM.reg(), ['query', key], { windowsHide: true, stdio: 'ignore', timeout: 15000 }).status === 0,
  );

export const UPDATE_RESTART_WARNING =
  'Windows is waiting to restart for updates and may do so on its own (often overnight), which closes the sandbox. Restart first, or pause updates: Settings > Windows Update > Pause updates.';
