#Requires -Version 5.1
# Agents that keep their login in the user profile (guest/agents/profile-links.ts): each profile folder becomes a
# junction to a folder in the persistent state. -PairsFile is a JSON array of {link, target}.
# A real folder already at the link is moved into the target first (files already in the target win).
param([Parameter(Mandatory = $true)][string]$PairsFile)
$ErrorActionPreference = 'Stop'

function Test-Junction([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return ($null -ne $item) -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

# Not wrapped in @(): Windows PowerShell 5.1 would make one element of the whole array.
$pairs = ConvertFrom-Json -InputObject (Get-Content -LiteralPath $PairsFile -Raw)
foreach ($pair in $pairs) {
    $link = [string]$pair.link
    $target = [string]$pair.target
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    if (Test-Path -LiteralPath $link) {
        if (Test-Junction $link) {
            $current = (Get-Item -LiteralPath $link -Force).Target
            if ($current -and ([string]$current).TrimEnd('\') -ieq $target.TrimEnd('\')) { continue }
            (Get-Item -LiteralPath $link -Force).Delete()
        }
        else {
            Get-ChildItem -LiteralPath $link -Force | ForEach-Object {
                $dest = Join-Path $target $_.Name
                if (-not (Test-Path -LiteralPath $dest)) { Move-Item -LiteralPath $_.FullName -Destination $dest }
            }
            Remove-Item -LiteralPath $link -Recurse -Force
        }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $link) | Out-Null
    New-Item -ItemType Junction -Path $link -Value $target | Out-Null
}
