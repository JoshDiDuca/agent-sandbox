#Requires -Version 5.1
# Lets the sandbox's paging file grow to sandbox.pageFileMb. Windows Sandbox starts with about 1 GB of it, so parallel
# builds run out of commit ("The paging file is too small", os error 1455) long before RAM is full. The change applies
# at once and the file only takes disk space when Windows needs it. Never stops the boot: it logs one line either way.
param([int]$MaxMb = 0)  # 0 = read sandbox.pageFileMb from session.json
$ErrorActionPreference = 'Stop'
$log = 'C:\AgentData\logs\logon-hit.txt'
try {
    if ($MaxMb -eq 0) { $MaxMb = [int](Get-Content -LiteralPath 'C:\AgentLaunch\session.json' -Raw -Encoding UTF8 | ConvertFrom-Json).pageFileMb }
    if ($MaxMb -le 0) { exit 0 }
    # Keep 8 GB of the sandbox's disk free for everything else.
    $MaxMb = [math]::Min($MaxMb, [math]::Floor((Get-PSDrive -Name C).Free / 1MB) - 8192)
    if ($MaxMb -lt 1024) { throw 'too little free disk.' }
    Add-Type -Path (Join-Path $PSScriptRoot 'pagefile.cs')
    [SandboxPageFile]::Grow([math]::Min(4096, $MaxMb), $MaxMb)
    "Paging file may grow to $MaxMb MB (sandbox.pageFileMb)." | Add-Content -LiteralPath $log
} catch {
    "Paging file left as it is: $($_.Exception.Message)" | Add-Content -LiteralPath $log
}
exit 0
