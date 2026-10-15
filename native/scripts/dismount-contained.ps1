#Requires -Version 5.1
# Detaches the contained-storage disk image of one data set (the image file stays, with everything in it). Run elevated
# (one Windows permission prompt). The request is a JSON file: { set, storageRoot, image, mount, userSid }. The same
# checks as mount-contained.ps1 apply (exact paths, no links, yours). It refuses while Windows Sandbox is running (the
# sandbox may be using the folders in the image). Only `detach vdisk` for this one image is run; nothing is deleted.
# -DryRun prints the diskpart lines and does nothing else; the result goes to result.json next to the request file.
param(
    [Parameter(Mandatory = $true)][string]$Json,
    [string]$Sha256 = '',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'contained-common.ps1')

$result = @{ ok = $false; message = ''; action = 'dismount'; created = $false; alreadyMounted = $false }

function Invoke-Dismount($Req, [bool]$Dry, [string]$TempDir) {
    Assert-NoLinksOnTheWay $Req $true
    $root = $Req.storageRoot.TrimEnd('\')
    Assert-OwnedByUser $Req @($root, (Join-Path $root 'images'), (Join-Path $root 'mounts'))
    if (-not (Test-Path -LiteralPath $Req.image -PathType Leaf)) { throw "The image is missing: $($Req.image)" }
    Assert-OwnedByUser $Req @($Req.image)
    $image = $Req.image
    $mount = $Req.mount.TrimEnd('\')
    if (-not $Dry) {
        if (Get-Process -Name 'WindowsSandbox*' -ErrorAction SilentlyContinue) {
            throw 'A Windows Sandbox is running and may be using the image. Close it first.'
        }
    }
    $state = Get-ImageState $image $Dry
    if ((-not $Dry) -and (-not $state.Attached)) {
        if (Test-ReparsePoint $mount) { throw "The mount folder is a mount point of something else; not touching it: $mount" }
        $script:result.ok = $true
        $script:result.message = 'The image is not mounted.'
        Add-Note 'not attached: nothing to do'
        return
    }
    [void](Invoke-DiskPart @("select vdisk file=""$image""", 'detach vdisk') $TempDir $Dry)
    if (-not $Dry) {
        $after = Get-ImageState $image $false
        if ($after.Attached) { throw 'The image is still attached (something is using it). Close programs that use files in it and try again.' }
        if (Test-ReparsePoint $mount) { throw "The mount folder is still a mount point: $mount" }
    }
    $script:result.ok = $true
    $script:result.message = 'The image was detached.'
}

$mutex = $null
try {
    $request = Read-ContainedRequest -JsonPath $Json -Sha256 $Sha256 -Dry $DryRun.IsPresent
    Assert-ContainedRequest $request
    if (-not $DryRun) {
        if (-not (Test-IsAdministrator)) { throw 'Detaching a disk image needs administrator rights.' }
        $mutex = Enter-ContainedLock
    }
    Invoke-Dismount $request $DryRun.IsPresent (Split-Path -Parent $Json)
} catch {
    $result.ok = $false
    $result.message = $_.Exception.Message
} finally {
    if ($mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() }
}
Write-ContainedResult $result $Json $DryRun.IsPresent
if ($result.ok) { exit 0 }
if ($DryRun) { [Console]::Error.WriteLine($result.message) }
exit 1
