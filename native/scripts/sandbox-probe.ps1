#Requires -Version 5.1
# What `sandbox setup` needs to know about this PC: CPU virtualization, a hypervisor, and the state of the Windows
# Sandbox feature. Readable without admin rights; prints one line of JSON.
param([string]$Feature = 'Containers-DisposableClientVM')
$ErrorActionPreference = 'SilentlyContinue'
$cpu = @(Get-CimInstance Win32_Processor)
$cs = Get-CimInstance Win32_ComputerSystem
$f = Get-CimInstance Win32_OptionalFeature -Filter "Name='$Feature'"
$v = $null
if ($cpu.Count) { $v = [bool]($cpu | Where-Object { $_.VirtualizationFirmwareEnabled }) }
$h = $null
if ($cs) { $h = [bool]$cs.HypervisorPresent }
$s = $null
if ($f) { $s = [int]$f.InstallState }
@{ virtualizationFirmware = $v; hypervisorPresent = $h; installState = $s } | ConvertTo-Json -Compress
