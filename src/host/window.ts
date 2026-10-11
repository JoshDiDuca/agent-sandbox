// Headless mode: Windows Sandbox always opens its client window, so we hide it (ShowWindow SW_HIDE) as soon as it
// appears. The VM and the logged-in session keep running; `sbx-show` brings the window back.
import path from 'node:path';
import { isWin, runPowerShell, runPowerShellAsync, tryReadJson, writeJson } from '../core/util.js';

const PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace AgentSandbox -Name Win -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr hWnd, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetWindow(System.IntPtr hWnd, uint cmd);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder s, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int cmd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
'@
function Get-SandboxWindows([bool]$visibleOnly) {
  $pids = @(Get-Process | Where-Object { $_.ProcessName -like 'WindowsSandbox*' } | ForEach-Object { [uint32]$_.Id })
  $found = New-Object System.Collections.ArrayList
  if ($pids.Count -eq 0) { return $found }
  $cb = [AgentSandbox.Win+EnumProc]{ param($h, $l)
    $p = [uint32]0; [void][AgentSandbox.Win]::GetWindowThreadProcessId($h, [ref]$p)
    if ($pids -contains $p -and [AgentSandbox.Win]::GetWindow($h, 4) -eq [IntPtr]::Zero) {
      $sb = New-Object System.Text.StringBuilder 256; [void][AgentSandbox.Win]::GetWindowText($h, $sb, 256)
      $title = $sb.ToString()
      if ($title -like '*Sandbox*' -and (-not $visibleOnly -or [AgentSandbox.Win]::IsWindowVisible($h))) { [void]$found.Add([int64]$h) }
    }
    return $true }
  [void][AgentSandbox.Win]::EnumWindows($cb, [IntPtr]::Zero)
  return $found
}
`;

const stateFile = (storageRoot: string): string => path.join(storageRoot, 'run', 'hidden-windows.json');

/** Waits for the sandbox window and hides it; keeps watching briefly in case Windows re-shows it while connecting. */
export const hideSandboxWindow = async (storageRoot: string, waitSeconds = 180): Promise<boolean> => {
  if (!isWin) return false;
  const script = PRELUDE + `
$hidden = New-Object System.Collections.ArrayList
$deadline = (Get-Date).AddSeconds(${waitSeconds}); $settle = $null
while ((Get-Date) -lt $deadline) {
  foreach ($h in (Get-SandboxWindows $true)) { [void][AgentSandbox.Win]::ShowWindow([IntPtr]$h, 0); if (-not $hidden.Contains($h)) { [void]$hidden.Add($h) } }
  if ($hidden.Count -gt 0 -and $null -eq $settle) { $settle = (Get-Date).AddSeconds(15) }
  if ($null -ne $settle -and (Get-Date) -gt $settle) { break }
  Start-Sleep -Milliseconds 200
}
ConvertTo-Json -Compress @($hidden)`;
  const stdout = await runPowerShellAsync(script);
  const handles = JSON.parse(stdout.trim() || '[]') as number[];
  writeJson(stateFile(storageRoot), { handles });
  return handles.length > 0;
};

/** Shows the sandbox window again (the ones we hid, or any hidden Windows Sandbox window). */
export const showSandboxWindow = (storageRoot: string): boolean => {
  if (!isWin) return false;
  const recorded = tryReadJson<{ handles: number[] }>(stateFile(storageRoot))?.handles ?? [];
  const script = PRELUDE + `
$handles = @(${recorded.join(',')}) | Where-Object { [AgentSandbox.Win]::IsWindow([IntPtr]$_) }
if (-not $handles) { $handles = Get-SandboxWindows $false }
foreach ($h in $handles) { [void][AgentSandbox.Win]::ShowWindow([IntPtr]$h, 5); [void][AgentSandbox.Win]::ShowWindow([IntPtr]$h, 9); [void][AgentSandbox.Win]::SetForegroundWindow([IntPtr]$h) }
@($handles).Count`;
  const { stdout } = runPowerShell(script, true);
  writeJson(stateFile(storageRoot), { handles: [] });
  return Number(stdout.trim()) > 0;
};
