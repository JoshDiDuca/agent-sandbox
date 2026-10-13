#Requires -Version 5.1
# Writes the sandbox's memory state to C:\AgentData\logs\memory-<time>.log while it runs: every 30 seconds, and every
# 5 when RAM or commit is above 60%. That folder outlives the sandbox, so if Windows inside it crashes, the last lines
# show what used memory just before. memory-pressure.txt holds the latest state (ok, high, critical) for agents to
# check before big builds. Bounded: a file is closed at 1 MB and a new one started; only the newest 10 are kept.
# Started hidden by logon.cmd. Never stops the boot.
$ErrorActionPreference = 'SilentlyContinue'
$logFolder = 'C:\AgentData\logs'
$pressureFile = Join-Path $logFolder 'memory-pressure.txt'
$maxFileBytes = 1MB
$keepFiles = 10

# A new log file, and the oldest ones beyond $keepFiles removed. Returns its path.
function New-MemoryLog {
    $path = Join-Path $logFolder ('memory-{0:yyyyMMdd-HHmmss}.log' -f (Get-Date))
    'time     | RAM used/total MB | commit used/limit MB | biggest processes (private MB)' | Set-Content -LiteralPath $path
    Get-ChildItem -LiteralPath $logFolder -Filter 'memory-*.log' | Sort-Object LastWriteTime -Descending |
        Select-Object -Skip $keepFiles | Remove-Item -Force
    return $path
}

$logPath = New-MemoryLog
while ($true) {
    $os = Get-CimInstance Win32_OperatingSystem
    $ramTotalMb = [math]::Round($os.TotalVisibleMemorySize / 1KB)
    $ramUsedMb = $ramTotalMb - [math]::Round($os.FreePhysicalMemory / 1KB)
    $commitLimitMb = [math]::Round($os.TotalVirtualMemorySize / 1KB)
    $commitUsedMb = $commitLimitMb - [math]::Round($os.FreeVirtualMemory / 1KB)
    $processes = @(Get-Process)
    $biggest = $processes | Sort-Object PrivateMemorySize64 -Descending | Select-Object -First 5 |
        ForEach-Object { '{0} {1}' -f $_.ProcessName, [math]::Round($_.PrivateMemorySize64 / 1MB) }
    $now = Get-Date
    '{0:HH:mm:ss} | {1}/{2} | {3}/{4} | {5} processes; {6}' -f $now, $ramUsedMb, $ramTotalMb, $commitUsedMb, $commitLimitMb, $processes.Count, ($biggest -join ', ') |
        Add-Content -LiteralPath $logPath

    $usedShare = [math]::Max($ramUsedMb / [math]::Max($ramTotalMb, 1), $commitUsedMb / [math]::Max($commitLimitMb, 1))
    $level = if ($usedShare -ge 0.85) { 'critical' } elseif ($usedShare -ge 0.6) { 'high' } else { 'ok' }
    '{0} {1:yyyy-MM-ddTHH:mm:ss} RAM {2}/{3} MB, commit {4}/{5} MB' -f $level, $now, $ramUsedMb, $ramTotalMb, $commitUsedMb, $commitLimitMb |
        Set-Content -LiteralPath $pressureFile

    if ((Get-Item -LiteralPath $logPath).Length -ge $maxFileBytes) { $logPath = New-MemoryLog }
    Start-Sleep -Seconds $(if ($level -eq 'ok') { 30 } else { 5 })
}
