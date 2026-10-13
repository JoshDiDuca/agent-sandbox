#Requires -Version 5.1
# Keeps this PC awake (the screen may still turn off) until the process -OwnerId ends: the background watcher, which
# ends with the sandbox. Used by host/stops.ts for sandbox.keepAwake.
param([Parameter(Mandatory = $true)][int]$OwnerId)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'power.cs')
[AgentSandbox.Power]::StayAwake()
Wait-Process -Id $OwnerId -ErrorAction SilentlyContinue
