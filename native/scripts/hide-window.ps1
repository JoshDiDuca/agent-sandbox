#Requires -Version 5.1
# Hides the Windows Sandbox window once it appears (a headless sandbox) and prints the hidden handles as JSON. The
# fallback for HostTools.exe hide-window (host/sandbox/window.ts).
param([Parameter(Mandatory = $true)][int]$WaitSeconds)
$ErrorActionPreference = 'Stop'

Add-Type -Path (Join-Path $PSScriptRoot '..\csharp\HostTools\Window.cs')
ConvertTo-Json -Compress @([AgentSandbox.Win]::Hide($WaitSeconds))
