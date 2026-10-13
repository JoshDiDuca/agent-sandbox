#Requires -Version 5.1
# Caps how much of the PC's CPU the sandbox may use (sandbox.cpuLimit). Windows Sandbox has no CPU setting and gets
# every processor, so heavy builds inside can take the whole PC. This puts logon.cmd (the parent of this script),
# before it starts anything, into a Windows job object with a hard CPU-rate cap; everything it starts inherits it:
# Windows Terminal and its tabs, the boot, the agents, installs and builds. Programs started from the sandbox's Start
# menu are not covered. Never stops the boot: it logs one line either way and the sandbox starts uncapped on failure.
param([int]$ProcessId = 0, [int]$Percent = 0)  # 0 = the parent process / cpuLimitPercent from session.json
$ErrorActionPreference = 'Stop'
$log = 'C:\AgentData\logs\logon-hit.txt'
try {
    if ($Percent -eq 0) { $Percent = [int](Get-Content -LiteralPath 'C:\AgentLaunch\session.json' -Raw -Encoding UTF8 | ConvertFrom-Json).cpuLimitPercent }
    if ($Percent -lt 1 -or $Percent -ge 100) { exit 0 }
    if ($ProcessId -eq 0) { $ProcessId = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId }
    Add-Type -Path (Join-Path $PSScriptRoot '..\csharp\CpuCap.cs')
    [SandboxCpuCap]::Apply($ProcessId, $Percent)
    "CPU capped at $Percent% of the PC (sandbox.cpuLimit)." | Add-Content -LiteralPath $log
} catch {
    "CPU cap not applied (the sandbox runs uncapped): $($_.Exception.Message)" | Add-Content -LiteralPath $log
}
exit 0
