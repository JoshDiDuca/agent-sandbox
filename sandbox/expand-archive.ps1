#Requires -Version 5.1
# Extracts a .zip when Windows' tar.exe could not (shared/download/archive.ts, on this PC and in the sandbox).
param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'

Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
