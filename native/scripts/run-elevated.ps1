#Requires -Version 5.1
# Runs one fixed PowerShell command in an elevated PowerShell (Windows asks for permission) and waits for it. Used by
# `sandbox setup` to turn on the Windows Sandbox feature. Exits with the command's exit code, or 1 when declined.
param([Parameter(Mandatory = $true)][string]$Command)
$ErrorActionPreference = 'Stop'
try {
    $exe = Join-Path $PSHOME 'powershell.exe'
    $p = Start-Process -FilePath $exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', $Command
    exit $p.ExitCode
} catch {
    exit 1
}
