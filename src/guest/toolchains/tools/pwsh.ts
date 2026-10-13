// PowerShell 7 (pwsh): the portable zip from PowerShell/PowerShell releases (no MSI: Windows Sandbox would lose it on
// every boot). Only `pwsh` is added; Windows PowerShell 5.1 (`powershell`, SYSTEM.powershell()) stays what the
// sandbox's own hooks and scripts use.
import { pwshAsset } from '../catalogue.js';
import { arch, tool, type ToolEnv } from '../tool-env.js';
import { setupSingleExe } from '../runtimes.js';

/** Where pwsh.exe lives (the host's Windows Terminal profile points at the same folder under C:\AgentData). */
export const pwshDir = (): string => tool('pwsh');

export const setupPwsh = async (env: ToolEnv, refresh = false): Promise<void> => {
  // pwsh.exe sits at the zip's root next to its runtime and modules: the whole folder is kept.
  await setupSingleExe(env, 'pwsh', 'PowerShell/PowerShell', pwshAsset(arch), 'pwsh.exe', pwshDir(), {
    refresh,
    size: '100 MB',
    versionArgs: ['-Version'],
    note: ' (PowerShell 7; powershell is still 5.1)',
  });
  // No update banner or telemetry from a copy that provisioning.refresh replaces anyway.
  Object.assign(env.vars, { POWERSHELL_UPDATECHECK: 'Off', POWERSHELL_TELEMETRY_OPTOUT: '1' });
};
