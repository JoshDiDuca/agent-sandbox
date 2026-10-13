import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../core/types.js';
import { updateRestartPending } from '../life/index.js';
import { dirExists, isWin } from '../../core/util/index.js';
import { probeHost } from './probe.js';
import { sandboxFeatureInstalled, isSandboxRunning } from './platform.js';

export const doctorRows = (
  config: Config,
  harnessName: string,
  storageRoot: string,
  configPath: string | null,
): [string, string][] => {
  const probe = probeHost(config, harnessName);
  return [
    ['Config file', configPath ?? '(none; built-in defaults; create one with: sandbox config init)'],
    ['Windows', isWin ? 'yes' : 'NO (launch needs Windows)'],
    ['Windows Sandbox feature', sandboxFeatureInstalled() ? 'enabled' : 'NOT enabled'],
    ['Sandbox running', isSandboxRunning() ? 'YES' : 'no'],
    ['Free host RAM (MB)', String(Math.floor(os.freemem() / 1048576))],
    [
      'Update restart pending',
      updateRestartPending()
        ? 'YES (Windows may restart on its own and close the sandbox; restart first or pause updates)'
        : 'no',
    ],
    [
      'Keep this PC awake',
      config.sandbox.keepAwake
        ? 'yes, while a sandbox runs'
        : 'no (sandbox.keepAwake is off: the PC may sleep under running agents)',
    ],
    [
      'Provisioning',
      config.provisioning.copyFromHost
        ? 'copy from this PC' + (config.provisioning.fallbackToInstall ? ', fall back to download' : ', no fallback')
        : 'download inside sandbox',
    ],
    ['Host Node (runner)', probe.nvmNode ? 'nvm ' + probe.hostNodeVersion : (probe.nodeDir ?? '(none; will download)')],
    ['Host nvm versions', probe.nvmDir ?? '(no NVM_HOME; versions will be downloaded)'],
    [
      'Host ' + harnessName,
      probe.harnessExe ? path.join(probe.harnessExe.dir, probe.harnessExe.file) : '(none; will npm install)',
    ],
    ['Host Git for Windows', probe.gitDir ?? '(none with bash; PortableGit will be downloaded)'],
    ['Storage root', storageRoot + (dirExists(storageRoot) ? '' : ' (will be created)')],
  ];
};
