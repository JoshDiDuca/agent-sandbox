#Requires -Version 5.1
# Lets the terminal's own input (mouse reports, focus, keys) reach process -ProcessId, which reads its console in raw
# mode (shared/pty/console-input.ts). Started hidden in a console of its own, it switches to that process's console.
# Exit code: 0 = done, 2-4 = see SbxVtInput.On in csharp\VtInput.cs.
param([Parameter(Mandatory = $true)][uint32]$ProcessId)
$ErrorActionPreference = 'Stop'

Add-Type -Path (Join-Path $PSScriptRoot '..\csharp\VtInput.cs')
exit [SbxVtInput]::On($ProcessId)
