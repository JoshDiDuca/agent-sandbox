#Requires -Version 5.1
# Looks at the contained-storage image of one data set without changing anything and prints one line of JSON:
# { imageExists, imageBytes, mountExists, mountIsMountPoint, attached }. `attached` is null when Windows will not say
# without administrator rights. Used by doctor, repair and the launch (host/storage/contained) to compare what the
# state file says with what is really mounted. Paths are never followed through links: a link gives mountIsMountPoint.
param(
    [Parameter(Mandatory = $true)][string]$Image,
    [Parameter(Mandatory = $true)][string]$Mount
)
$ErrorActionPreference = 'Stop'

$answer = [ordered]@{ imageExists = $false; imageBytes = 0; mountExists = $false; mountIsMountPoint = $false; attached = $null }
try {
    if (Test-Path -LiteralPath $Image -PathType Leaf) {
        $answer.imageExists = $true
        $answer.imageBytes = (Get-Item -LiteralPath $Image -Force).Length
        try { $answer.attached = [bool](Get-DiskImage -ImagePath $Image -ErrorAction Stop).Attached } catch { $answer.attached = $null }
    }
    if (Test-Path -LiteralPath $Mount -PathType Container) {
        $answer.mountExists = $true
        $answer.mountIsMountPoint = [bool]([IO.File]::GetAttributes($Mount) -band [IO.FileAttributes]::ReparsePoint)
    }
    Write-Output ($answer | ConvertTo-Json -Compress)
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
