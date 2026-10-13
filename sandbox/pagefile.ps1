#Requires -Version 5.1
# Gives the sandbox a paging file of sandbox.pageFileMb, created at full size now, before anything runs. Windows Sandbox
# starts with about 1 GB, so parallel builds run out of memory ("The paging file is too small", os error 1455), and
# then Windows grows the file while they run: both crashes of Windows inside the sandbox (13 Oct 2026, stop code 0x1A
# MEMORY_MANAGEMENT) happened under that load. A fixed size never grows. Never stops the boot: it logs one line.
param([int]$SizeMb = 0)  # 0 = read sandbox.pageFileMb from session.json
$ErrorActionPreference = 'Stop'
$log = 'C:\AgentData\logs\logon-hit.txt'
try {
    if ($SizeMb -eq 0) { $SizeMb = [int](Get-Content -LiteralPath 'C:\AgentLaunch\session.json' -Raw -Encoding UTF8 | ConvertFrom-Json).pageFileMb }
    if ($SizeMb -le 0) { exit 0 }
    # Keep 8 GB of the sandbox's disk free for everything else.
    $SizeMb = [math]::Min($SizeMb, [math]::Floor((Get-PSDrive -Name C).Free / 1MB) - 8192)
    if ($SizeMb -lt 1024) { throw 'too little free disk.' }
    Add-Type -Path (Join-Path $PSScriptRoot 'pagefile.cs')
    [SandboxPageFile]::Set($SizeMb)
    "Paging file set to $SizeMb MB, fixed (sandbox.pageFileMb)." | Add-Content -LiteralPath $log
} catch {
    "Paging file left as it is: $($_.Exception.Message)" | Add-Content -LiteralPath $log
}
exit 0
