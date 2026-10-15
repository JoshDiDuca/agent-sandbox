#Requires -Version 5.1
<#
.SYNOPSIS
  P0 probe for an HCS (Host Compute Service) backend. Run on the REAL PC, once as a normal user and once elevated.
.DESCRIPTION
  Read-only. Creates no VM, container, network, disk or file outside %TEMP%; changes no setting. It:
   - reports the OS, hypervisor and Windows features (Containers, Hyper-V, Windows Sandbox, VM Platform);
   - lists the relevant services and files (vmcompute, CmService, hns, computecore.dll, hcsdiag.exe);
   - lists the Windows Sandbox base image folder (top level only);
   - asks HCS for its service properties (supported schema versions) and enumerates compute systems
     (start Windows Sandbox first to see its own definition);
   - says whether the current user can call HCS without admin.
  The report goes to the screen and to a text file in %TEMP% (path printed). Paste it back.
.PARAMETER ReportPath
  Where to write the report. Default: %TEMP%\hcs-probe-<time>.txt
#>
[CmdletBinding()]
param(
  [string]$ReportPath = ''
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2.0

if (-not $ReportPath) { $ReportPath = Join-Path $env:TEMP ('hcs-probe-{0:yyyyMMdd-HHmmss}.txt' -f (Get-Date)) }
$script:Lines = New-Object System.Collections.Generic.List[string]

function Say([string]$Text) {
  Write-Host $Text
  $script:Lines.Add($Text)
}
function Section([string]$Title) {
  Say ''
  Say ('== ' + $Title)
}
function Try-Do([string]$What, [scriptblock]$Body) {
  try { & $Body } catch { Say ('  {0}: FAILED ({1})' -f $What, $_.Exception.Message) }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$hvAdminSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-578')
$inHvAdmins = $principal.IsInRole($hvAdminSid)

Section 'Who and what'
Say ('  Time:            {0:u}' -f (Get-Date))
Say ('  User:            {0}' -f $identity.Name)
Say ('  Elevated admin:  {0}' -f $isAdmin)
Say ('  In Hyper-V Administrators (token): {0}' -f $inHvAdmins)
Try-Do 'os' {
  $os = Get-CimInstance Win32_OperatingSystem
  Say ('  OS:              {0} {1} build {2}' -f $os.Caption, $os.Version, $os.BuildNumber)
  $ubr = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').UBR
  Say ('  Revision (UBR):  {0}' -f $ubr)
  $cs = Get-CimInstance Win32_ComputerSystem
  Say ('  HypervisorPresent: {0}   RAM: {1} GB' -f $cs.HypervisorPresent, [math]::Round($cs.TotalPhysicalMemory / 1GB, 1))
}
Say ('  PowerShell:      {0}' -f $PSVersionTable.PSVersion)

Section 'Windows features (Win32_OptionalFeature; InstallState 1 = enabled)'
$featureNames = @(
  'Containers', 'Containers-DisposableClientVM', 'Microsoft-Hyper-V-All', 'Microsoft-Hyper-V-Hypervisor',
  'Microsoft-Hyper-V-Services', 'VirtualMachinePlatform', 'HypervisorPlatform'
)
Try-Do 'features' {
  $found = @{}
  foreach ($f in @(Get-CimInstance Win32_OptionalFeature -ErrorAction Stop)) { $found[$f.Name] = $f.InstallState }
  foreach ($n in $featureNames) {
    $state = 'not present on this edition'
    if ($found.ContainsKey($n)) {
      $state = switch ([int]$found[$n]) { 1 { 'ENABLED' } 2 { 'disabled' } 3 { 'absent' } default { 'state ' + $found[$n] } }
    }
    Say ('  {0,-34} {1}' -f $n, $state)
  }
  Say '  (Containers-DisposableClientVM is the Windows Sandbox feature.)'
}

Section 'Services'
foreach ($n in @('vmcompute', 'CmService', 'hns', 'vmms', 'vmic*', 'docker', 'containerd', 'WSLService')) {
  Try-Do $n {
    $svc = @(Get-Service -Name $n -ErrorAction SilentlyContinue)
    if ($svc.Count -eq 0) { Say ('  {0,-12} not installed' -f $n) }
    else { foreach ($s in $svc) { Say ('  {0,-12} {1} ({2})' -f $s.Name, $s.Status, $s.StartType) } }
  }
}

Section 'Files'
$sys = Join-Path $env:SystemRoot 'System32'
foreach ($f in @('computecore.dll', 'vmcompute.exe', 'hcsdiag.exe', 'WindowsSandbox.exe', 'WindowsSandboxClient.exe', 'wclayer.exe', 'computestorage.dll', 'cmservice.dll', 'vmwp.exe', 'hvsocket.dll')) {
  $p = Join-Path $sys $f
  if (Test-Path -LiteralPath $p) {
    $v = (Get-Item -LiteralPath $p).VersionInfo.FileVersion
    Say ('  {0,-26} present  {1}' -f $f, $v)
  } else { Say ('  {0,-26} missing' -f $f) }
}
foreach ($p in @('C:\Program Files\Docker', 'C:\ProgramData\docker', 'C:\Program Files\containerd')) {
  Say ('  {0,-40} {1}' -f $p, $(if (Test-Path -LiteralPath $p) { 'present' } else { 'missing' }))
}

Section 'Windows Sandbox base image folder (top level only, nothing is opened or changed)'
$containers = 'C:\ProgramData\Microsoft\Windows\Containers'
foreach ($p in @($containers, (Join-Path $containers 'BaseImages'), (Join-Path $containers 'Layers'), (Join-Path $containers 'Sandboxes'))) {
  Try-Do $p {
    if (Test-Path -LiteralPath $p) {
      Say ('  {0}' -f $p)
      $items = @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Select-Object -First 25)
      foreach ($i in $items) {
        $size = ''
        if (-not $i.PSIsContainer) { $size = '{0:N0} bytes' -f $i.Length }
        Say ('    {0}  {1}  {2:u}  {3}' -f $(if ($i.PSIsContainer) { '<DIR>' } else { '     ' }), $i.Name, $i.LastWriteTime, $size)
      }
      if ($items.Count -eq 0) { Say '    (empty)' }
    } else { Say ('  {0}  missing' -f $p) }
  }
}
Try-Do 'ACL' {
  if (Test-Path -LiteralPath $containers) {
    $acl = Get-Acl -LiteralPath $containers
    Say ('  Containers folder owner: {0}' -f $acl.Owner)
    foreach ($a in $acl.Access) { Say ('    {0} {1} {2}' -f $a.IdentityReference, $a.AccessControlType, $a.FileSystemRights) }
  }
}

Section 'HCS calls (computecore.dll, queries only)'
$csPath = Join-Path $PSScriptRoot 'HcsProbe.cs'
$loaded = $false
if (-not (Test-Path -LiteralPath $csPath)) {
  Say ('  HcsProbe.cs not found next to this script ({0}).' -f $csPath)
} else {
  $tmpDll = Join-Path $env:TEMP ('HcsProbe-{0}.dll' -f ([guid]::NewGuid().ToString('N')))
  $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  Try-Do 'compile' {
    if (Test-Path -LiteralPath $csc) {
      $out = & $csc /nologo /target:library /optimize+ "/out:$tmpDll" $csPath 2>&1
      if ($LASTEXITCODE -ne 0) { throw ('csc failed: ' + ($out -join ' ')) }
      Add-Type -Path $tmpDll
      Say ('  Compiled with csc.exe into {0}' -f $tmpDll)
    } else {
      Add-Type -Path $csPath
      Say '  csc.exe not found; used Add-Type.'
    }
    $script:loaded = $true
  }
}

if ($loaded) {
  Try-Do 'HcsGetServiceProperties' {
    $r = [AgentSandbox.Experiments.HcsProbe]::GetServiceProperties('{"PropertyTypes":["Basic"]}')
    Say ('  HcsGetServiceProperties(Basic): HRESULT {0} ({1})' -f $r.HResultText(), $r.Message())
    if ($r.Json) {
      Say ('  Raw: {0}' -f $r.Json.Substring(0, [math]::Min(1500, $r.Json.Length)))
      $m = [regex]::Matches($r.Json, '"Major"\s*:\s*(\d+)\s*,\s*"Minor"\s*:\s*(\d+)')
      $vers = @(foreach ($x in $m) { '{0}.{1}' -f $x.Groups[1].Value, $x.Groups[2].Value })
      if ($vers.Count -gt 0) { Say ('  Schema versions seen: {0}' -f ($vers -join ', ')) }
    }
  }
  Try-Do 'HcsEnumerateComputeSystems' {
    $r = [AgentSandbox.Experiments.HcsProbe]::EnumerateComputeSystems($null)
    Say ('  HcsEnumerateComputeSystems: HRESULT {0} ({1})' -f $r.HResultText(), $r.Message())
    if ($r.Json) {
      $list = $null
      try { $list = @($r.Json | ConvertFrom-Json) } catch { Say ('  (result is not JSON) {0}' -f $r.Json.Substring(0, [math]::Min(500, $r.Json.Length))) }
      if ($null -ne $list) {
        Say ('  Compute systems visible: {0}' -f $list.Count)
        foreach ($c in $list) {
          $props = @()
          foreach ($pn in @('Id', 'SystemType', 'Owner', 'State', 'RuntimeId', 'RuntimeOsType', 'IsDummy')) {
            if ($c.PSObject.Properties.Name -contains $pn) { $props += ('{0}={1}' -f $pn, $c.$pn) }
          }
          Say ('    ' + ($props -join '  '))
        }
        Say '  Full JSON follows (start Windows Sandbox first to capture its own definition):'
        Say ('  ' + $r.Json.Substring(0, [math]::Min(6000, $r.Json.Length)))
      }
    }
  }
  if ($tmpDll) { Try-Do 'cleanup' { Remove-Item -LiteralPath $tmpDll -Force -ErrorAction SilentlyContinue } }
}

Section 'hcsdiag list (if present; read-only)'
$hcsdiag = Join-Path $sys 'hcsdiag.exe'
if (Test-Path -LiteralPath $hcsdiag) {
  Try-Do 'hcsdiag' { foreach ($l in @(& $hcsdiag list 2>&1)) { Say ('  ' + $l) } }
} else { Say '  hcsdiag.exe not present (it ships with the Containers feature).' }

Section 'Verdict hints'
Say ('  Ran elevated: {0}.  Run again {1} to compare.' -f $isAdmin, $(if ($isAdmin) { 'WITHOUT elevation' } else { 'AS ADMINISTRATOR' }))
Say '  If HcsGetServiceProperties works unelevated but HcsEnumerateComputeSystems is access denied (0x80070005), HCS needs admin or Hyper-V Administrators.'
Say '  Windows Sandbox features alone may show a Windows Sandbox compute system while it runs; paste that JSON back.'

Section 'Done'
try {
  [IO.File]::WriteAllLines($ReportPath, $script:Lines.ToArray())
  Say ('  Report saved to {0}' -f $ReportPath)
} catch { Say ('  Could not save report: {0}' -f $_.Exception.Message) }
