import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { refuseInSelfTest } from '../test-guard.js';

/** Runs a PowerShell script that edits YOUR PATH (HKCU\Environment) unexpanded, then tells Windows it changed. */
export const editUserPath = (dir: string, add: boolean): void => {
  refuseInSelfTest('change your PATH');
  const quoted = "'" + dir.replace(/'/g, "''") + "'";
  const script = [
    '$dir = ' + quoted,
    "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
    'try {',
    "  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "  $rest = @($raw -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $dir.TrimEnd('\\') })",
    // First, so these commands win over the agents' own folders (also on YOUR PATH).
    add ? "  $new = (@($dir) + $rest) -join ';'" : "  $new = $rest -join ';'",
    "  if ($new -eq $raw.TrimEnd(';')) { exit 0 }",
    "  if ($new.Length -gt 32000) { Write-Error 'PATH too long'; exit 3 }",
    "  $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }",
    "  $key.SetValue('Path', $new, $kind)",
    '} finally { $key.Close() }',
    'Add-Type -Namespace WdsAgents -Name Native -MemberDefinition \'[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);\'',
    '$ignored = [UIntPtr]::Zero',
    "[void][WdsAgents.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$ignored)",
  ].join('\n');
  const result = spawnSync(
    SYSTEM.powershell(),
    ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status === 3) throw new Error('Your PATH is too long to add ' + dir + '.');
  if (result.status !== 0)
    throw new Error(
      'Could not ' +
        (add ? 'add ' + dir + ' to' : 'remove ' + dir + ' from') +
        ' your PATH: ' +
        (result.stderr || result.error?.message || 'exit ' + result.status).trim(),
    );
};
