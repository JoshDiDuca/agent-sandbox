#Requires -Version 5.1
# Writes the sandbox's memory state to C:\AgentData\logs\memory-<time>.log every 30 seconds, while it runs. That folder
# outlives the sandbox, so if Windows inside it ever crashes again, the last lines show what was using memory just
# before. Bounded: a file is closed at 1 MB (about two days) and a new one started; only the newest 10 are kept, so
# the logs never take more than about 10 MB. Started hidden by logon.cmd. Never stops the boot.
$ErrorActionPreference = 'SilentlyContinue'
$logFolder = 'C:\AgentData\logs'
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
    '{0:HH:mm:ss} | {1}/{2} | {3}/{4} | {5} processes; {6}' -f (Get-Date), $ramUsedMb, $ramTotalMb, $commitUsedMb, $commitLimitMb, $processes.Count, ($biggest -join ', ') |
        Add-Content -LiteralPath $logPath
    if ((Get-Item -LiteralPath $logPath).Length -ge $maxFileBytes) { $logPath = New-MemoryLog }
    Start-Sleep -Seconds 30
}
