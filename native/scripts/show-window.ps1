#Requires -Version 5.1
# Shows the Windows Sandbox window again (-Handles, the ones hidden before, else any) and prints how many. The fallback
# for HostTools.exe show-window (host/sandbox/window.ts). -Handles is a comma-separated list of integers.
param([string]$Handles = '')
$ErrorActionPreference = 'Stop'

Add-Type -Path (Join-Path $PSScriptRoot '..\csharp\HostTools\Window.cs')
$recorded = New-Object 'System.Collections.Generic.List[long]'
foreach ($part in ($Handles -split ',')) {
    $handle = 0L
    if ([long]::TryParse($part, [ref]$handle)) { $recorded.Add($handle) }
}
[AgentSandbox.Win]::Show($recorded)
