#Requires -Version 5.1
# Creates (or, with -Remove, deletes) the scheduled task \WindowsDevelopmentSandbox\Update: every day at 03:00 (plus up to
# an hour of random delay) it runs "<Command> update --unattended" as SYSTEM, whether anyone is logged on or not, and
# when the PC was off at that time it runs as soon as it can. -Command is the installed bin\sandbox.cmd.
# Needs an admin PowerShell. Exit 0 when done, 2 when not admin, 1 with the reason on stderr otherwise.
param(
    [string]$Command,
    [switch]$Remove,
    # Test aid: only checks the arguments and the permission, changes nothing.
    [switch]$WhatIfOnly
)
$ErrorActionPreference = 'Stop'

try {
    $principalCheck = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        [Console]::Error.WriteLine('This needs admin rights. Run it in an admin PowerShell (right-click Start > Terminal (Admin)).')
        exit 2
    }
    $taskPath = '\WindowsDevelopmentSandbox\'
    $taskName = 'Update'
    if ($Remove) {
        if ($WhatIfOnly) { exit 0 }
        if (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false
        }
        exit 0
    }
    if (-not $Command -or -not [IO.Path]::IsPathRooted($Command) -or -not (Test-Path -LiteralPath $Command -PathType Leaf)) {
        throw "-Command must be the full path of the installed sandbox.cmd (got '$Command')."
    }
    if ($WhatIfOnly) { exit 0 }
    $action = New-ScheduledTaskAction -Execute $Command -Argument 'update --unattended'
    $trigger = New-ScheduledTaskTrigger -Daily -At '03:00' -RandomDelay (New-TimeSpan -Hours 1)
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Installs new versions of Windows Development Sandbox when no sandbox is running.'
    Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -InputObject $task -Force | Out-Null
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
