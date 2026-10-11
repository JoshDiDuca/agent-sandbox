# windows-development-sandbox installer. Run in a normal (not admin) PowerShell:
#   irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1 | iex
# It checks this PC can run Windows Sandbox, offers to turn the feature on and to install Node.js, then installs the
# CLI with npm. Only enabling the Windows feature asks for admin rights. Set WDS_PACKAGE to install another build.
# Windows PowerShell 5.1 compatible. Wrapped in a script block so `return` never closes the user's window under iex.
& {
  # Not 'Stop': Windows PowerShell 5.1 would turn npm's and winget's warnings on stderr into fatal errors.
  $ErrorActionPreference = 'Continue'
  $package = 'https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/windows-development-sandbox.tgz'
  if ($env:WDS_PACKAGE) { $package = $env:WDS_PACKAGE }
  $feature = 'Containers-DisposableClientVM'
  $enableCommand = "Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart"
  $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
  $problems = New-Object System.Collections.Generic.List[string]
  $rebootNeeded = $false

  function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
  function Ok($text) { Write-Host "   OK      $text" -ForegroundColor Green }
  function Warn($text) { Write-Host "   WARNING $text" -ForegroundColor Yellow }
  function Problem($text) { Write-Host "   PROBLEM $text" -ForegroundColor Red; $problems.Add([string]$text) }
  function Ask($question) {
    if (-not $interactive) { return $false }
    $answer = Read-Host "   $question [y/N]"
    return $answer -match '^(y|yes)$'
  }
  function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  function Node-Major {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
    $version = (& node --version) -replace '^v', ''
    return [int]($version.Split('.')[0])
  }

  Write-Host 'windows-development-sandbox installer' -ForegroundColor White
  Write-Host 'Runs AI coding agents in Windows Sandbox, a throwaway Windows that is wiped when it closes.'

  # 1. Windows edition -------------------------------------------------------------------------------------------
  Step 'Checking your Windows edition'
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $edition = [string]$cv.EditionID
  $build = [int]$cv.CurrentBuildNumber
  if ($edition -like 'Core*') {
    Problem "This PC runs Windows Home ($edition). Windows Sandbox is only part of Windows Pro, Enterprise and Education."
    Write-Host '   Upgrade to Windows Pro (Settings > System > Activation), then run this installer again.'
    return
  }
  if ($edition -like 'Server*') {
    Problem "This is Windows Server ($edition). Windows Sandbox needs Windows 10/11 Pro, Enterprise or Education."
    return
  }
  if ($build -lt 18305) {
    Problem "Windows build $build is too old. Windows Sandbox needs Windows 10 version 1903 or newer; run Windows Update."
    return
  }
  if ($edition -match '^(Professional|Enterprise|Education|IoTEnterprise)') { Ok "$($cv.ProductName -replace 'Windows 10', $(if ($build -ge 22000) { 'Windows 11' } else { 'Windows 10' })) ($edition, build $build)" }
  else { Warn "Not sure edition '$edition' has Windows Sandbox (it needs Pro, Enterprise or Education). Carrying on." }

  # 2. Hardware --------------------------------------------------------------------------------------------------
  Step 'Checking virtualization and memory'
  $cs = Get-CimInstance Win32_ComputerSystem
  $cpus = @(Get-CimInstance Win32_Processor)
  # With Hyper-V running, the CPU reports firmware virtualization as off, so a running hypervisor also counts.
  if ($cs.HypervisorPresent -or ($cpus | Where-Object { $_.VirtualizationFirmwareEnabled })) { Ok 'CPU virtualization is on' }
  else {
    Problem 'CPU virtualization looks switched off.'
    Write-Host '   Restart into your BIOS/UEFI settings and turn on Intel VT-x / AMD-V (sometimes called SVM), then try again.'
  }
  $ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  if ($ramGb -lt 4) { Problem "Only $ramGb GB of memory. Windows Sandbox needs at least 4 GB." }
  elseif ($ramGb -lt 8) { Warn "$ramGb GB of memory. It works, but 8 GB or more is recommended." }
  else { Ok "$ramGb GB of memory" }

  # 3. Windows Sandbox feature -----------------------------------------------------------------------------------
  Step 'Checking the Windows Sandbox feature'
  $exe = Join-Path $env:SystemRoot 'System32\WindowsSandbox.exe'
  # InstallState 1 = enabled. The query needs the Windows servicing service; when that is off, go by the program file.
  try { $state = (Get-CimInstance Win32_OptionalFeature -Filter "Name='$feature'" -ErrorAction Stop).InstallState } catch { $state = $null }
  if ($null -eq $state -and (Test-Path $exe)) { $state = 1 }
  if ($state -eq 1 -and (Test-Path $exe)) { Ok 'Windows Sandbox is enabled' }
  elseif ($state -eq 1) { Warn 'Windows Sandbox is enabled, but Windows needs a restart to finish.'; $rebootNeeded = $true }
  else {
    Write-Host '   Windows Sandbox is not turned on yet.'
    if (Ask 'Turn it on now? Windows will ask for admin permission') {
      Write-Host '   Enabling Windows Sandbox (this can take a minute)...'
      try {
        $p = Start-Process -FilePath $powershellExe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', "$enableCommand | Out-Null"
        if ($p.ExitCode -eq 0) { Ok 'Windows Sandbox enabled. Restart Windows to finish.'; $rebootNeeded = $true }
        else { Problem "Enabling Windows Sandbox failed (exit code $($p.ExitCode))." }
      } catch { Problem 'The admin prompt was declined, so Windows Sandbox was not enabled.' }
    } else {
      Problem 'Windows Sandbox is not enabled.'
      Write-Host '   To turn it on yourself, run this in an admin PowerShell, then restart Windows:'
      Write-Host "     $enableCommand" -ForegroundColor White
    }
  }

  # 4. Node.js ---------------------------------------------------------------------------------------------------
  Step 'Checking Node.js (20 or newer)'
  $major = Node-Major
  if ($major -ge 20) { Ok "Node.js $(& node --version)" }
  else {
    if ($major -gt 0) { Write-Host "   Node.js $(& node --version) is too old." } else { Write-Host '   Node.js is not installed.' }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
      Problem 'Node.js 20 or newer is needed, and winget (App Installer) is not available to install it.'
      Write-Host '   Install the LTS version from https://nodejs.org, open a new PowerShell and run this installer again.'
      return
    }
    if (-not (Ask 'Install Node.js LTS with winget now?')) {
      Problem 'Node.js 20 or newer is needed.'
      Write-Host '   Install it with: winget install OpenJS.NodeJS.LTS   (or from https://nodejs.org), then run this again.'
      return
    }
    & winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
    $major = Node-Major
    if ($major -lt 20) {
      Problem 'Node.js was installed but is not usable in this window yet.'
      Write-Host '   Open a new PowerShell window and run this installer again.'
      return
    }
    Ok "Node.js $(& node --version) installed"
  }

  # 5. The CLI ---------------------------------------------------------------------------------------------------
  Step 'Installing windows-development-sandbox'
  Write-Host "   npm install -g $package"
  # npm.cmd, not npm: the npm.ps1 shim is blocked when scripts are disabled on this PC.
  # The old agent-sandbox package ships the same commands; npm will not install over it.
  if ((& npm.cmd ls -g --depth=0 agent-sandbox 2>$null) -match 'agent-sandbox@') { Write-Host '   Removing the old agent-sandbox package (it is now windows-development-sandbox) ...'; & npm.cmd uninstall -g agent-sandbox | Out-Null }
  & npm.cmd install -g $package
  if ($LASTEXITCODE -ne 0) {
    Problem "npm could not install the package (exit code $LASTEXITCODE)."
    Write-Host '   Check your internet connection and try again. Details are in the npm output above.'
    return
  }
  Refresh-Path
  $cli = Join-Path ((& npm.cmd prefix -g) | Select-Object -Last 1).Trim() 'agent-sandbox.cmd'
  if (-not (Test-Path $cli)) { $cli = 'agent-sandbox.cmd' }
  Ok 'Installed'

  Step 'Checking everything with agent-sandbox doctor'
  & $cli doctor

  # Summary ------------------------------------------------------------------------------------------------------
  Write-Host ''
  if ($problems.Count) {
    Write-Host 'Installed, but some things need fixing before a sandbox can start:' -ForegroundColor Yellow
    foreach ($item in $problems) { Write-Host "  - $item" }
  }
  if ($rebootNeeded) { Write-Host 'Restart Windows to finish turning on Windows Sandbox.' -ForegroundColor Yellow }
  Write-Host ''
  Write-Host 'What next:' -ForegroundColor Cyan
  Write-Host '  1. Open a new terminal and cd into a project folder.'
  Write-Host '  2. Run claude-sbx to start Claude Code in a sandbox with that folder as its workspace.'
  Write-Host '     Or run sandbox for a sandbox with no agent.'
  Write-Host '  3. Run agent-sandbox setup or agent-sandbox doctor any time to check this PC again.'
}
