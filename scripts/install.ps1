# windows-development-sandbox installer. Run in a normal (not admin) PowerShell:
#   irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1 | iex
# It checks this PC can run Windows Sandbox, offers to turn the feature on, then installs the CLI with npm: with your
# Node.js 20+ if you have it, else with a private Node.js used only by this tool (nothing installed system-wide). Only enabling the Windows feature asks for admin rights. Set WDS_PACKAGE to install another build.
# The release package must match the SHA-256 GitHub lists for it; with none listed the install is refused unless WDS_ALLOW_UNVERIFIED=1.
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
    # Keep what this session already had (a portable Node, for example) and add what installers registered.
    $parts = @($env:Path -split ';') + @([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') + @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')
    $env:Path = ($parts | Where-Object { $_ } | Select-Object -Unique) -join ';'
  }
  function Remove-Inside($path, $root) {
    # The only deletes in this script: a folder this script made, never anything outside the folder it was given.
    $full = [IO.Path]::GetFullPath($path).TrimEnd('\')
    $base = [IO.Path]::GetFullPath($root).TrimEnd('\')
    if (-not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing to delete $full (not inside $base)" }
    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue }
  }
  function Add-UserPath($dir) {
    # Adds this one folder to YOUR PATH and touches nothing else in it. The value is read and written back unexpanded (so
    # entries such as %USERPROFILE%\bin stay as they are), and a PATH that would get too long is left alone.
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
      $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if (@($raw -split ';') | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') }) { return }
      $new = if ($raw) { $raw.TrimEnd(';') + ';' + $dir } else { $dir }
      if ($new.Length -gt 32000) { Warn "Your PATH is too long to add $dir. Add it yourself in Settings > System > About > Advanced system settings > Environment Variables."; return }
      $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
      $key.SetValue('Path', $new, $kind)
    } finally { $key.Close() }
    # Tell running programs (Explorer, so new terminals) that the environment changed.
    try {
      Add-Type -Namespace WdsInstall -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'
      $ignored = [UIntPtr]::Zero
      [void][WdsInstall.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$ignored)
    } catch { Warn 'Open a new terminal (or sign out and in) to pick up the new PATH.' }
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
  # Your own Node is used when it is new enough. Otherwise nothing is installed system-wide: a private Node (the
  # official zip, checksum-verified) runs only this tool, and only its commands go on your PATH, not node itself.
  Step 'Checking Node.js (20 or newer)'
  # This tool's own folder, always under LOCALAPPDATA, never anything that could resolve to a profile or the current folder.
  if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) { Problem 'LOCALAPPDATA is not set, so there is nowhere safe to put the private Node.js.'; return }
  $toolFolder = Join-Path $env:LOCALAPPDATA 'WindowsDevelopmentSandbox'
  $privateNode = Join-Path $toolFolder 'node'
  $npm = 'npm.cmd'
  $major = Node-Major
  if ($major -ge 20) { Ok "using your Node.js $(& node --version)" }
  elseif (Test-Path (Join-Path $privateNode 'node.exe')) { $npm = Join-Path $privateNode 'npm.cmd'; Ok "using the private Node.js in $privateNode" }
  else {
    if ($major -gt 0) { Write-Host "   Your Node.js $(& node --version) is too old; it is left alone." } else { Write-Host '   No Node.js on this PC.' }
    Write-Host "   Downloading a private Node.js LTS just for this tool (into $privateNode; nothing is installed system-wide) ..."
    try {
      # A loop, not a pipeline: Windows PowerShell 5.1 passes a JSON array down the pipeline as ONE object.
      $lts = $null
      foreach ($release in (Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing)) { if ($release.lts) { $lts = $release.version; break } }
      if ($lts -notmatch '^v\d+\.\d+\.\d+$') { throw 'no Node.js LTS release found' }
      $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
      $name = "node-$lts-win-$arch"
      $ProgressPreference = 'SilentlyContinue'
      # A fresh folder of our own for the download, so the only things deleted are folders made here.
      $work = Join-Path $toolFolder ('download-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Force $work | Out-Null
      try {
        $zip = Join-Path $work "$name.zip"
        Invoke-WebRequest "https://nodejs.org/dist/$lts/$name.zip" -OutFile $zip -UseBasicParsing
        $sums = (Invoke-WebRequest "https://nodejs.org/dist/$lts/SHASUMS256.txt" -UseBasicParsing).Content
        $expected = @($sums -split "`n" | Where-Object { $_ -match " $name\.zip\s*$" } | ForEach-Object { ($_ -split '\s+')[0] })
        if ($expected.Count -ne 1 -or $expected[0] -notmatch '^[0-9a-fA-F]{64}$' -or (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected[0].ToUpper()) { throw "checksum mismatch for $name.zip" }
        $staging = Join-Path $work 'x'
        Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
        if (-not (Test-Path -LiteralPath (Join-Path $staging "$name\node.exe"))) { throw 'node.exe is not in the download' }
        Remove-Inside $privateNode $toolFolder
        Move-Item -LiteralPath (Join-Path $staging $name) -Destination $privateNode
      } finally { Remove-Inside $work $toolFolder }
    } catch {
      Problem "Could not download Node.js: $_"
      Write-Host '   Check your internet connection and run this again (or install Node.js 20+ yourself from https://nodejs.org).'
      return
    }
    $npm = Join-Path $privateNode 'npm.cmd'
    Ok "private Node.js $lts in $privateNode"
  }

  # 5. The CLI ---------------------------------------------------------------------------------------------------
  Step 'Installing windows-development-sandbox'
  # The release package is downloaded first and checked against the SHA-256 GitHub publishes for it. A package you named
  # yourself with WDS_PACKAGE is installed as given.
  $installFrom = $package
  $download = $null
  if (-not $env:WDS_PACKAGE) {
    $download = Join-Path $toolFolder ('download-' + [guid]::NewGuid().ToString('N'))
    try {
      $release = Invoke-RestMethod 'https://api.github.com/repos/JoshDiDuca/windows-development-sandbox/releases/latest' -UseBasicParsing -Headers @{ 'User-Agent' = 'windows-development-sandbox-installer' }
      $asset = @($release.assets | Where-Object { $_.name -eq 'windows-development-sandbox.tgz' })[0]
      $expected = if ($asset -and "$($asset.digest)" -match '^sha256:([0-9a-fA-F]{64})$') { $Matches[1] } else { $null }
      if (-not $asset) { throw 'the release has no windows-development-sandbox.tgz' }
      if ($expected) {
        New-Item -ItemType Directory -Force $download | Out-Null
        $file = Join-Path $download 'windows-development-sandbox.tgz'
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest $asset.browser_download_url -OutFile $file -UseBasicParsing
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expected.ToUpper()) { throw 'the download does not match the SHA-256 GitHub lists for it' }
        $installFrom = $file
        Ok 'package downloaded and its SHA-256 matches'
      } elseif ($env:WDS_ALLOW_UNVERIFIED -eq '1') { Warn 'GitHub lists no SHA-256 for this package; installing it unverified because WDS_ALLOW_UNVERIFIED=1.' }
      else { throw 'GitHub lists no SHA-256 for this package, so it cannot be checked, and it is not installed. To install it anyway, set $env:WDS_ALLOW_UNVERIFIED = "1" and run the installer again.' }
    } catch {
      Problem "Could not check the package: $_"
      Remove-Inside $download $toolFolder
      return
    }
  }
  Write-Host "   npm install -g $installFrom"
  # npm.cmd, not npm: the npm.ps1 shim is blocked when scripts are disabled on this PC.
  # The old agent-sandbox package ships the same commands; npm will not install over it.
  if ((& $npm ls -g --depth=0 agent-sandbox 2>$null) -match 'agent-sandbox@') { Write-Host '   Removing the old agent-sandbox package (it is now windows-development-sandbox) ...'; & $npm uninstall -g agent-sandbox | Out-Null }
  & $npm install -g $installFrom
  $npmExit = $LASTEXITCODE
  if ($download) { Remove-Inside $download $toolFolder }
  if ($npmExit -ne 0) {
    Problem "npm could not install the package (exit code $npmExit)."
    Write-Host '   Check your internet connection and try again. Details are in the npm output above.'
    return
  }
  Refresh-Path
  $prefix = ((& $npm prefix -g 2>$null) | Select-Object -Last 1)
  if ($prefix) { $prefix = $prefix.Trim() }
  if ($npm -ne 'npm.cmd') {
    # With the private Node, put small wrappers for our commands on your PATH (not node.exe itself).
    $bin = Join-Path $toolFolder 'bin'
    New-Item -ItemType Directory -Force $bin | Out-Null
    $commands = 'sandbox', 'windows-development-sandbox', 'agent-sandbox', 'claude-sandbox', 'codex-sandbox', 'gemini-sandbox', 'claude-sbx', 'codex-sbx', 'gemini-sbx', 'claude-host', 'sbx-show', 'sbx-hide'
    foreach ($c in $commands) { if (Test-Path (Join-Path $prefix "$c.cmd")) { Set-Content -Path (Join-Path $bin "$c.cmd") -Value "@`"$prefix\$c.cmd`" %*" -Encoding ASCII } }
    Add-UserPath $bin
    $env:Path = "$bin;$env:Path"
    $prefix = $bin
  }
  $cli = if ($prefix) { Join-Path $prefix 'sandbox.cmd' } else { $null }
  if (-not $cli -or -not (Test-Path $cli)) { $cli = 'sandbox.cmd' }
  Ok 'Installed'

  Step 'Checking everything with sandbox doctor'
  if (Get-Command $cli -ErrorAction SilentlyContinue) { & $cli doctor } else { Warn 'Open a new terminal and run: sandbox doctor' }

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
  Write-Host '  2. Run sandbox for the menu, claude-sbx for Claude Code, or sandbox start for a sandbox with no agent.'
  Write-Host '  3. Run sandbox setup or sandbox doctor any time to check this PC again.'
}
