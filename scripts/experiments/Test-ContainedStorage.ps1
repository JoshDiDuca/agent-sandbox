#Requires -Version 5.1
# Probe for contained storage (docs/roadmap.md, "Contained storage"): can Windows Sandbox use folders that live inside
# a mounted VHDX disk image, and how fast are they compared to a plain folder? Run it once on your PC, in an admin
# PowerShell, with no sandbox running:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\experiments\Test-ContainedStorage.ps1
# Everything happens in %TEMP%\agent-sandbox-vhd-probe: a 4 GB dynamic test image (a few MB on disk) mounted at a
# folder there (no drive letter), a plain folder next to it, and a .wsb that maps a folder of each into a sandbox with
# networking off. The sandbox writes, lists and deletes small files in both and writes the times to a results file.
# Close the sandbox window when the results are printed: the image is then unmounted and the probe folder deleted
# (-Keep keeps them). Nothing else on your PC is touched.
param(
    [switch]$Keep,
    [ValidateRange(100, 100000)][int]$Files = 5000,
    [ValidateRange(60, 3600)][int]$TimeoutSeconds = 600
)
$ErrorActionPreference = 'Stop'

$root = Join-Path $env:TEMP 'agent-sandbox-vhd-probe'
$vhd = Join-Path $root 'probe.vhdx'
$mount = Join-Path $root 'mounted'
$plain = Join-Path $root 'plain'
$results = Join-Path $root 'results'
$guest = Join-Path $root 'guest'
$diskpart = Join-Path $env:SystemRoot 'System32\diskpart.exe'
$sandboxExe = Join-Path $env:SystemRoot 'System32\WindowsSandbox.exe'

function Invoke-DiskPart([string[]]$Lines) {
    $file = Join-Path $root ('diskpart-' + [guid]::NewGuid().ToString('N') + '.txt')
    Set-Content -LiteralPath $file -Value $Lines -Encoding ASCII
    try {
        $output = & $diskpart /s $file 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "diskpart failed (exit $LASTEXITCODE):`n$output" }
        return $output
    } finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
}

function Dismount-ProbeImage {
    if (-not (Test-Path -LiteralPath $vhd)) { return }
    try {
        Invoke-DiskPart @("select vdisk file=""$vhd""", 'detach vdisk') | Out-Null
        Write-Host '  image unmounted'
    } catch {
        # Not attached (already detached, or the attach never happened): nothing to undo.
    }
}

function Test-StillMounted {
    # The mount folder is a reparse point while the image is attached there.
    if (-not (Test-Path -LiteralPath $mount)) { return $false }
    return [bool]((Get-Item -LiteralPath $mount -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Remove-ProbeFolder {
    # Never delete while the image is still attached: the delete would reach into the mounted volume.
    if (Test-StillMounted) {
        Write-Host "  the image is still mounted at $mount, so nothing was deleted." -ForegroundColor Yellow
        Write-Host "  Unmount it in Disk Management (or: diskpart, select vdisk file=""$vhd"", detach vdisk), then delete $root." -ForegroundColor Yellow
        return
    }
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $root) { Write-Host "  could not delete $root; delete it by hand" } else { Write-Host '  probe folder deleted' }
}

function Test-SandboxRunning {
    return [bool](Get-Process -Name 'WindowsSandbox*' -ErrorAction SilentlyContinue)
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Run this in an admin PowerShell (mounting a disk image needs admin rights).' }
if (-not (Test-Path -LiteralPath $sandboxExe)) { throw 'Windows Sandbox is not turned on (sandbox setup turns it on).' }
if (Test-SandboxRunning) { throw 'A Windows Sandbox is running. Close it first (Windows Sandbox runs one at a time).' }

Write-Host "Contained storage probe in $root"
if (Test-Path -LiteralPath $root) {
    Dismount-ProbeImage
    if (Test-StillMounted) { throw "A probe image from an earlier run is still mounted at $mount. Unmount it first (Disk Management)." }
    Remove-Item -LiteralPath $root -Recurse -Force
}
New-Item -ItemType Directory -Force $root, $mount, $plain, $results, $guest | Out-Null

try {
    Write-Host '1. Creating and mounting a 4 GB dynamic image (no drive letter)'
    Invoke-DiskPart @(
        "create vdisk file=""$vhd"" maximum=4096 type=expandable",
        "select vdisk file=""$vhd""",
        'attach vdisk',
        'create partition primary',
        'format fs=ntfs quick label=ProbeData',
        "assign mount=""$mount"""
    ) | Out-Null
    $inImage = Join-Path $mount 'tools'
    New-Item -ItemType Directory -Force $inImage | Out-Null
    Set-Content -LiteralPath (Join-Path $inImage 'from-pc.txt') -Value 'written on the PC' -Encoding ASCII
    Write-Host "  mounted at $mount"

    Write-Host '2. Writing the sandbox configuration'
    $probe = @"
`$lines = @()
foreach (`$t in @(@{ Name = 'image'; Path = 'C:\Probe\image' }, @{ Name = 'plain'; Path = 'C:\Probe\plain' })) {
    try {
        `$seen = Test-Path -LiteralPath (Join-Path `$t.Path 'from-pc.txt')
        `$dir = Join-Path `$t.Path 'files'
        New-Item -ItemType Directory -Force `$dir | Out-Null
        `$sw = [Diagnostics.Stopwatch]::StartNew()
        for (`$i = 0; `$i -lt $Files; `$i++) { [IO.File]::WriteAllText((Join-Path `$dir ("f" + `$i + ".txt")), "file " + `$i) }
        `$write = `$sw.ElapsedMilliseconds; `$sw.Restart()
        `$count = @(Get-ChildItem -LiteralPath `$dir -File).Count
        `$list = `$sw.ElapsedMilliseconds; `$sw.Restart()
        Remove-Item -LiteralPath `$dir -Recurse -Force
        `$delete = `$sw.ElapsedMilliseconds
        `$lines += (`$t.Name + ': writable, write ' + `$write + ' ms, list ' + `$list + ' ms (' + `$count + ' files), delete ' + `$delete + ' ms, file from the PC seen: ' + `$seen)
    } catch {
        `$lines += (`$t.Name + ': FAILED ' + `$_.Exception.Message)
    }
}
Set-Content -LiteralPath 'C:\Probe\results\result.txt' -Value `$lines -Encoding ASCII
"@
    Set-Content -LiteralPath (Join-Path $guest 'probe.ps1') -Value $probe -Encoding ASCII
    $esc = { param($s) [Security.SecurityElement]::Escape($s) }
    $wsb = Join-Path $root 'probe.wsb'
    $xml = @"
<Configuration>
  <Networking>Disable</Networking>
  <MappedFolders>
    <MappedFolder><HostFolder>$(& $esc $inImage)</HostFolder><SandboxFolder>C:\Probe\image</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(& $esc $plain)</HostFolder><SandboxFolder>C:\Probe\plain</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(& $esc $results)</HostFolder><SandboxFolder>C:\Probe\results</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(& $esc $guest)</HostFolder><SandboxFolder>C:\Probe\guest</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Probe\guest\probe.ps1</Command></LogonCommand>
</Configuration>
"@
    Set-Content -LiteralPath $wsb -Value $xml -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $plain 'from-pc.txt') -Value 'written on the PC' -Encoding ASCII

    Write-Host "3. Starting the sandbox (waiting up to $TimeoutSeconds seconds for the results)"
    Start-Process -FilePath $wsb
    $resultFile = Join-Path $results 'result.txt'
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (-not (Test-Path -LiteralPath $resultFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
    Write-Host ''
    if (Test-Path -LiteralPath $resultFile) {
        Write-Host 'RESULTS (paste these back to Claude):' -ForegroundColor Green
        Write-Host "  files per folder: $Files"
        Get-Content -LiteralPath $resultFile | ForEach-Object { Write-Host "  $_" }
        $after = @(Get-ChildItem -LiteralPath $inImage -Force | Select-Object -ExpandProperty Name) -join ', '
        Write-Host "  image folder seen from the PC afterwards: $after"
    } else {
        Write-Host 'NO RESULTS: the sandbox did not report in time. If Windows Sandbox showed an error about a mapped folder,' -ForegroundColor Yellow
        Write-Host 'that is the answer (a folder inside a mounted image cannot be mapped). Please send Claude its exact text.' -ForegroundColor Yellow
    }

    Write-Host ''
    Write-Host '4. Close the Windows Sandbox window to finish.'
    while (Test-SandboxRunning) { Start-Sleep -Seconds 2 }
} finally {
    Dismount-ProbeImage
    if (-not $Keep -and (Test-Path -LiteralPath $root)) { Remove-ProbeFolder }
}
