#Requires -Version 5.1
# Keeps this PC awake (the screen may still turn off) until the process -OwnerId ends: the background watcher, which
# ends with the sandbox. The fallback for HostTools.exe keep-awake (host/life/keep-awake.ts, sandbox.keepAwake).
param([Parameter(Mandatory = $true)][int]$OwnerId)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot '..\csharp\HostTools\KeepAwake.cs')
[AgentSandbox.Power]::StayAwake()
Wait-Process -Id $OwnerId -ErrorAction SilentlyContinue
