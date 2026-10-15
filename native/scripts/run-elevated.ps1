#Requires -Version 5.1
# Runs one fixed PowerShell command, or one script of this package, in an elevated PowerShell (Windows asks for
# permission) and waits for it. -Command is used by `sandbox setup` to turn on the Windows Sandbox feature. -Script is
# used for contained storage: the script (a file of this package) gets -Json <request file> -Sha256 <its checksum>.
# Exits with the exit code of what it ran, or 1 when the permission was declined.
[CmdletBinding(DefaultParameterSetName = 'Command')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Command')][string]$Command,
    [Parameter(Mandatory = $true, ParameterSetName = 'Script')][string]$Script,
    [Parameter(Mandatory = $true, ParameterSetName = 'Script')][string]$Json,
    [Parameter(Mandatory = $true, ParameterSetName = 'Script')][string]$Sha256
)
$ErrorActionPreference = 'Stop'
try {
    $exe = Join-Path $PSHOME 'powershell.exe'
    if ($PSCmdlet.ParameterSetName -eq 'Script') {
        $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $Script + '"'), '-Json', ('"' + $Json + '"'), '-Sha256', $Sha256)
    } else {
        $arguments = @('-NoProfile', '-Command', $Command)
    }
    $p = Start-Process -FilePath $exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList $arguments
    exit $p.ExitCode
} catch {
    exit 1
}
