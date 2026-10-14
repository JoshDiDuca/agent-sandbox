#Requires -Version 5.1
# Puts -Dir first on your PATH (-Add) or takes it off, then tells Windows it changed. Exit 3: PATH would be too long.
# The fallback for HostTools.exe user-path (host/agent-commands/user-path.ts).
param(
    [Parameter(Mandatory = $true)][string]$Dir,
    [switch]$Add
)
$ErrorActionPreference = 'Stop'

Add-Type -Path (Join-Path $PSScriptRoot '..\csharp\HostTools\UserPath.cs')
exit [AgentSandbox.UserPath]::Edit($Dir, [bool]$Add)
