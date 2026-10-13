#Requires -Version 5.1
# Writes the sandbox's memory state to C:\AgentData\logs\memory-<start time>.log every 30 seconds, while it runs. That
# folder outlives the sandbox, so if Windows inside it ever crashes again, the last lines show what was using memory
# just before. Started hidden by logon.cmd; keeps the last 10 logs. Never stops the boot.
$ErrorActionPreference = 'SilentlyContinue'
$logFolder = 'C:\AgentData\logs'
$logPath = Join-Path $logFolder ('memory-{0:yyyyMMdd-HHmmss}.log' -f (Get-Date))
Get-ChildItem -LiteralPath $logFolder -Filter 'memory-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 9 | Remove-Item -Force
'time     | RAM used/total MB | commit used/limit MB | biggest processes (private MB)' | Add-Content -LiteralPath $logPath

while ($true) {
    $os = Get-CimInstance Win32_OperatingSystem
    $ramTotalMb = [math]::Round($os.TotalVisibleMemorySize / 1KB)
    $ramUsedMb = $ramTotalMb - [math]::Round($os.FreePhysicalMemory / 1KB)
    $commitLimitMb = [math]::Round($os.TotalVirtualMemorySize / 1KB)
    $commitUsedMb = $commitLimitMb - [math]::Round($os.FreeVirtualMemory / 1KB)
    $biggest = Get-Process | Sort-Object PrivateMemorySize64 -Descending | Select-Object -First 5 |
        ForEach-Object { '{0} {1}' -f $_.ProcessName, [math]::Round($_.PrivateMemorySize64 / 1MB) }
    $processCount = @(Get-Process).Count
    '{0:HH:mm:ss} | {1}/{2} | {3}/{4} | {5} processes; {6}' -f (Get-Date), $ramUsedMb, $ramTotalMb, $commitUsedMb, $commitLimitMb, $processCount, ($biggest -join ', ') |
        Add-Content -LiteralPath $logPath
    Start-Sleep -Seconds 30
}
