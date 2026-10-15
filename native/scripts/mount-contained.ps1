#Requires -Version 5.1
# Mounts the contained-storage disk image of one data set at its mount folder (no drive letter), creating and
# formatting the image the very first time. Run elevated (host/storage/contained starts it through run-elevated.ps1,
# one Windows permission prompt). The request is a JSON file: { set, storageRoot, image, mount, userSid, maxGb, create }.
# Safety, all checked again here: the image is <storage>\images\<set>.vhdx and the mount folder <storage>\mounts\<set>;
# no folder on the way is a link; both are yours; the image has no parent file and is not bigger than the limit; an
# existing image is only attached (never formatted, never deleted), and a new one is only made where no file is.
# Every diskpart command names this one image. -DryRun checks everything and prints the diskpart lines it would run
# (and does nothing else); the result of a real run goes to result.json next to the request file.
param(
    [Parameter(Mandatory = $true)][string]$Json,
    [string]$Sha256 = '',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'contained-common.ps1')

$result = @{ ok = $false; message = ''; action = 'mount'; created = $false; alreadyMounted = $false }

function Invoke-Mount($Req, [bool]$Dry, [string]$TempDir) {
    foreach ($name in @('maxGb', 'create')) {
        if (-not ($Req.PSObject.Properties.Name -contains $name)) { throw "The request has no $name." }
    }
    if ($Req.maxGb -lt 8 -or $Req.maxGb -gt 4096) { throw 'The size limit must be between 8 and 4096 GB.' }
    $create = [bool]$Req.create
    Assert-NoLinksOnTheWay $Req $true
    $root = $Req.storageRoot.TrimEnd('\')
    $mountIsLink = Test-ReparsePoint $Req.mount
    Assert-OwnedByUser $Req @($root, (Join-Path $root 'images'), (Join-Path $root 'mounts'))
    # A mounted folder shows the image's own root, whose owner is not ours to judge; a plain folder is.
    if (-not $mountIsLink) { Assert-OwnedByUser $Req @($Req.mount) }
    $exists = Test-Path -LiteralPath $Req.image -PathType Leaf
    if ($create -and $exists) { throw "An image exists already; refusing to create over it: $($Req.image)" }
    if ((-not $create) -and (-not $exists)) { throw "The image is missing: $($Req.image)" }
    $image = $Req.image
    $mount = $Req.mount.TrimEnd('\')

    if ($exists) {
        Assert-OwnedByUser $Req @($image)
        $state = Get-ImageState $image $Dry
        if ($state.Attached) {
            if ((Test-MountedAt $state $mount) -and $mountIsLink) {
                $script:result.ok = $true
                $script:result.alreadyMounted = $true
                $script:result.message = 'The image is mounted already.'
                Add-Note 'already mounted at the mount folder'
                return
            }
            throw 'The image is attached somewhere else (Disk Management or another tool). Detach it there first.'
        }
        # Not attached, so its header can be read.
        [void](Assert-PlainImage $Req $Dry)
    }
    if ($mountIsLink) { throw "The mount folder is a mount point already: $mount" }
    if (@(Get-ChildItem -LiteralPath $mount -Force).Count -ne 0) { throw "The mount folder is not empty: $mount" }
    $format = (New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($mount))).DriveFormat
    if ($format -ne 'NTFS') { throw "The mount folder must be on an NTFS drive (this one is $format): $mount" }

    if ($exists) {
        # Attach and mount the first partition of this image; nothing is created and nothing is formatted.
        $lines = @(
            "select vdisk file=""$image""",
            'attach vdisk',
            'select partition 1',
            "assign mount=""$mount"""
        )
    } else {
        if (-not $Dry) {
            $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($image))
            if ($drive.AvailableFreeSpace -lt 1GB) { throw 'There is less than 1 GB free where the image would be made.' }
        }
        $megabytes = [int]$Req.maxGb * 1024
        $lines = @(
            "create vdisk file=""$image"" maximum=$megabytes type=expandable",
            "select vdisk file=""$image""",
            'attach vdisk',
            'create partition primary',
            'format fs=ntfs quick label=AgentData',
            "assign mount=""$mount"""
        )
    }
    try {
        [void](Invoke-DiskPart $lines $TempDir $Dry)
        if (-not $Dry) {
            $after = Get-ImageState $image $false
            if (-not $after.Attached -or -not (Test-MountedAt $after $mount)) { throw 'The image is attached but not mounted at the mount folder.' }
            if (-not (Test-ReparsePoint $mount)) { throw 'The mount folder is not a mount point after mounting.' }
            if (-not $exists) {
                # The new volume's root is open to Users by default: only you and the system may use it.
                $acl = New-Object Security.AccessControl.DirectorySecurity
                $acl.SetAccessRuleProtection($true, $false)
                $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
                foreach ($sid in @($Req.userSid, 'S-1-5-18')) {
                    $who = New-Object Security.Principal.SecurityIdentifier($sid)
                    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who, 'FullControl', $inherit, 'None', 'Allow')))
                }
                Set-Acl -LiteralPath $mount -AclObject $acl
            }
        }
        $script:result.ok = $true
        $script:result.created = (-not $exists)
        $script:result.message = if ($exists) { 'The image was mounted.' } else { 'The image was created and mounted.' }
    } catch {
        $problem = $_.Exception.Message
        if (-not $Dry) {
            # Leave the PC as it was: detach this image (only this one); a half-made new image is renamed, never deleted.
            $now = $null
            try { $now = Get-ImageState $image $false } catch { $now = $null }
            if ((Test-Path -LiteralPath $image) -and ((-not $now) -or $now.Attached)) {
                try { [void](Invoke-DiskPart @("select vdisk file=""$image""", 'detach vdisk') $TempDir $false) } catch { $problem += ' (it could not be detached again: ' + $_.Exception.Message + ')' }
            }
            if ((-not $exists) -and (Test-Path -LiteralPath $image)) {
                $kept = $image + '.failed-' + (Get-Date -Format 'yyyyMMddHHmmss')
                try { Rename-Item -LiteralPath $image -NewName (Split-Path -Leaf $kept); $problem += " (the unfinished image was kept as $kept)" } catch { $problem += ' (the unfinished image is still at ' + $image + ')' }
            }
        }
        throw $problem
    }
}

$mutex = $null
try {
    $request = Read-ContainedRequest -JsonPath $Json -Sha256 $Sha256 -Dry $DryRun.IsPresent
    Assert-ContainedRequest $request
    if (-not $DryRun) {
        if (-not (Test-IsAdministrator)) { throw 'Mounting a disk image needs administrator rights.' }
        $mutex = Enter-ContainedLock
    }
    Invoke-Mount $request $DryRun.IsPresent (Split-Path -Parent $Json)
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
