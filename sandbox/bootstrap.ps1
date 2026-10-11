#Requires -Version 5.1
# Runs INSIDE Windows Sandbox (Windows PowerShell 5.1) in the sandbox window, started by logon.cmd.
# Its only job: make sure the runner's Node exists in persistent storage, then hand over to runtime\main.js.
# (That Node only runs agent-sandbox itself; the agent's `node` comes from nvm.)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # progress bars make PS 5.1 downloads extremely slow
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$launchDir = 'C:\AgentLaunch'
$dataDir = 'C:\AgentData'
$hostNodeDir = 'C:\HostTools\node'
$hostNvm = 'C:\HostTools\nvm'
$toolsDir = Join-Path $dataDir 'tools'
# The runner's Node lives with nvm's versions (tools\nvm\v<version>), so nvm reuses it instead of copying it again.
$nvmDir = Join-Path $toolsDir 'nvm'
$runnerFile = Join-Path $toolsDir 'runner-node.txt'
$nodeDir = $null
$nodeExe = $null
$logsDir = Join-Path $dataDir 'logs'
$runDir = Join-Path $dataDir 'run'
foreach ($dir in @($logsDir, $toolsDir, $nvmDir, $runDir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$host.UI.RawUI.WindowTitle = 'Agent Sandbox'
Write-Host 'Agent sandbox bootstrap started.' -ForegroundColor Cyan
$transcript = Join-Path $logsDir ('bootstrap-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
Start-Transcript -Path $transcript | Out-Null
$transcriptStopped = $false
$session = Get-Content -LiteralPath (Join-Path $launchDir 'session.json') -Raw | ConvertFrom-Json
$hostVersion = [string]$session.hostTools.nodeVersion

function Set-Status([string]$Phase, [string]$Message) {
    # Same shape as SandboxStatus in src/shared/schema.ts; written atomically so the host never reads half a file.
    $status = [ordered]@{ launchId = $session.launchId; phase = $Phase; message = $Message; updatedAt = (Get-Date).ToUniversalTime().ToString('o'); workspaceHost = $session.workspaceHost; guestWorkspace = $session.workspace; headless = [bool]$session.headless }
    $file = Join-Path $runDir 'sandbox.json'
    [IO.File]::WriteAllText("$file.tmp", ($status | ConvertTo-Json -Compress))
    Move-Item -LiteralPath "$file.tmp" -Destination $file -Force
}

function Invoke-Download([string]$Uri, [string]$OutFile) {
    # The sandbox network can take a few seconds to come up, so retry.
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            if ($OutFile) { Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing; return $null }
            $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing
            if ($response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($response.Content) }
            return [string]$response.Content
        }
        catch {
            if ($attempt -eq 5) { throw }
            Write-Warning "Download failed (attempt $attempt of 5): $($_.Exception.Message). Retrying ..."
            Start-Sleep -Seconds 4
        }
    }
}

function Set-Runner([string]$Version) {
    $script:nodeDir = Join-Path $nvmDir ('v' + $Version.TrimStart('v'))
    $script:nodeExe = Join-Path $script:nodeDir 'node.exe'
}

function Test-Node {
    if (-not (Test-Path -LiteralPath $nodeExe)) { return $false }
    try { $null = & $nodeExe --version; return ($LASTEXITCODE -eq 0) } catch { return $false }
}

function Find-CachedRunner {
    # This PC's version first (nvm will want it anyway), else whichever version the last boot used.
    $last = if (Test-Path -LiteralPath $runnerFile) { (Get-Content -LiteralPath $runnerFile -Raw).Trim() } else { '' }
    foreach ($version in @($hostVersion, $last)) {
        if ($version -notmatch '^\d+\.\d+\.\d+$') { continue }
        Set-Runner $version
        if (Test-Node) { return $true }
    }
    return $false
}

function Publish-Directory([string]$Staging, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    Move-Item -LiteralPath $Staging -Destination $Destination
}

function Get-Size([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { return 0 } else { return [long]$sum }
}

function Invoke-Robocopy([string]$Label, [string]$From, [string]$To, [string[]]$Options, [long]$Total) {
    # Runs robocopy in the background and prints how far it has got, so a slow copy never looks frozen.
    # /R:2 /W:1: robocopy's default is 1,000,000 retries 30 s apart, which hangs "forever" on one unreadable file.
    $totalMb = [math]::Round($Total / 1MB, 1)
    Write-Host "  $Label ($totalMb MB) ..."
    $argList = @("`"$From`"", "`"$To`"") + $Options + @('/XJ', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    $process = Start-Process -FilePath 'robocopy.exe' -ArgumentList $argList -NoNewWindow -PassThru
    $null = $process.Handle   # keeps ExitCode readable after the process exits
    $started = Get-Date
    while (-not $process.WaitForExit(2000)) {
        $done = Get-Size $To
        $pct = if ($Total -gt 0) { [math]::Min(100, [math]::Floor($done * 100 / $Total)) } else { 0 }
        $secs = [int]((Get-Date) - $started).TotalSeconds
        Write-Host ("  {0}: {1} of {2} MB ({3}%), {4}s" -f $Label, [math]::Round($done / 1MB, 1), $totalMb, $pct, $secs)
    }
    $code = $process.ExitCode
    if ($code -ge 8) { Write-Warning "robocopy failed copying $Label (exit code $code)"; return $false }
    Write-Host ("  {0}: done in {1}s" -f $Label, [int]((Get-Date) - $started).TotalSeconds)
    return $true
}

function Copy-NodeFromHost {
    # The host maps one of these: nvm (when this PC's Node is an nvm version) or the plain Node folder.
    if ($hostVersion -notmatch '^\d+\.\d+\.\d+$') { return $false }
    $hostNode = @((Join-Path $hostNvm "v$hostVersion"), $hostNodeDir) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'node.exe') } | Select-Object -First 1
    if (-not $hostNode) { return $false }
    # Only node.exe, the npm shims and node_modules\npm (same list as copyNode in src/guest/env.ts): nothing else is
    # needed, and the folder can hold every global npm package, i.e. tens of thousands of small files over a slow mapping.
    Write-Host "Copying Node $hostVersion from this PC ($hostNode) ..."
    Set-Status 'booting' 'Copying Node from this PC'
    $staging = Join-Path $toolsDir 'node-staging'
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    $files = @('node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd')
    $filesSize = ($files | ForEach-Object { Get-Item -LiteralPath (Join-Path $hostNode $_) -ErrorAction SilentlyContinue } | Measure-Object -Property Length -Sum).Sum
    $npmFrom = Join-Path $hostNode 'node_modules\npm'
    $ok = (Invoke-Robocopy -Label 'node.exe' -From $hostNode -To $staging -Options ($files + '/J') -Total ([long]$filesSize)) -and
          (Invoke-Robocopy -Label 'npm' -From $npmFrom -To (Join-Path $staging 'node_modules\npm') -Options @('/E', '/MT:16') -Total (Get-Size $npmFrom))
    if (-not $ok) { return $false }
    Set-Runner $hostVersion
    Publish-Directory -Staging $staging -Destination $nodeDir
    return (Test-Node)
}

function Update-Environment {
    # main.js writes PATH and the tool variables machine-wide; reload them so this (-NoExit) shell has nvm, git, etc.
    foreach ($scope in @('Machine', 'User')) {
        $vars = [Environment]::GetEnvironmentVariables($scope)
        foreach ($name in $vars.Keys) { if ($name -ne 'Path') { Set-Item -LiteralPath "env:$name" -Value ([string]$vars[$name]) } }
    }
    $env:PATH = ([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User') | Where-Object { $_ }) -join ';'
}

function Install-NodeFromWeb {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    Write-Host 'Looking up the Node LTS release ...'
    $index = (Invoke-Download -Uri 'https://nodejs.org/dist/index.json') | ConvertFrom-Json
    $release = $index | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
    if ($null -eq $release) { throw "No Node LTS release found ($arch)." }
    $version = [string]$release.version
    if ($version -notmatch '^v\d+\.\d+\.\d+$') { throw "Unexpected Node version string: $version" }
    $zipName = "node-$version-win-$arch.zip"
    $baseUrl = "https://nodejs.org/dist/$version"
    $work = Join-Path $toolsDir ('node-work-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    try {
        $zipPath = Join-Path $work $zipName
        Write-Host "Downloading $zipName ..."
        $null = Invoke-Download -Uri "$baseUrl/$zipName" -OutFile $zipPath
        $sums = Invoke-Download -Uri "$baseUrl/SHASUMS256.txt"
        $line = ($sums -split "`n") | Where-Object { $_.Trim() -like "*  $zipName" } | Select-Object -First 1
        if (-not $line) { throw "No checksum entry for $zipName" }
        $expected = ($line.Trim() -split '\s+')[0]
        if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash -ne $expected.ToUpper()) { throw 'Node download failed checksum verification.' }
        $extractDir = Join-Path $work 'extracted'
        New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
        & tar.exe -xf $zipPath -C $extractDir
        if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 0; Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force }
        $inner = Join-Path $extractDir "node-$version-win-$arch"
        if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe'))) { throw 'Unexpected Node archive layout.' }
        Set-Runner $version
        Publish-Directory -Staging $inner -Destination $nodeDir
    }
    finally {
        if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

try {
    Set-Status 'booting' 'Preparing the runner'
    $provisioning = $session.provisioning
    if (-not $provisioning.refresh -and (Find-CachedRunner)) {
        Write-Host ('Runner Node ' + (& $nodeExe --version) + ' cached in persistent storage.')
    }
    else {
        $ready = $false
        if ($provisioning.copyFromHost) {
            $ready = Copy-NodeFromHost
            if (-not $ready) {
                if (-not $provisioning.fallbackToInstall) { throw 'Could not copy Node from this PC and provisioning.fallbackToInstall is false.' }
                Write-Warning 'Host Node unavailable; downloading Node instead.'
            }
        }
        if (-not $ready) { Install-NodeFromWeb }
        if (-not (Test-Node)) { throw 'Node is not runnable after provisioning.' }
        Write-Host ('Runner Node ' + (& $nodeExe --version) + ' ready.')
    }
    [IO.File]::WriteAllText($runnerFile, (Split-Path -Leaf $nodeDir).TrimStart('v'))
    # Older versions kept a full copy of the host's Node folder here.
    $legacy = Join-Path $toolsDir 'node'
    if (Test-Path -LiteralPath $legacy) { Remove-Item -LiteralPath $legacy -Recurse -Force -ErrorAction SilentlyContinue }

    $env:PATH = "$nodeDir;$env:PATH"
    Set-Location -LiteralPath $session.workspace
    Stop-Transcript | Out-Null
    $transcriptStopped = $true
    & $nodeExe (Join-Path $launchDir 'runtime\main.js')
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        # main.js reports its own failures; this catches it dying before it could (e.g. a broken Node).
        $current = Get-Content -LiteralPath (Join-Path $runDir 'sandbox.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($null -eq $current -or $current.phase -ne 'failed') { Set-Status 'failed' ("The sandbox runner stopped (exit code $code). See C:\AgentData\logs.") }
        Write-Host "The sandbox runner stopped with exit code $code. Logs: $logsDir" -ForegroundColor Red
    }
    Update-Environment
    Write-Host "This window stays open in $($session.workspace)."
}
catch {
    $report = ($_ | Format-List * -Force | Out-String) + "`r`n" + $_.ScriptStackTrace
    Set-Content -Path (Join-Path $logsDir 'bootstrap-error.txt') -Value $report -Encoding UTF8
    try { Set-Status 'failed' ('Bootstrap failed: ' + $_.Exception.Message) } catch { }
    Write-Host $report -ForegroundColor Red
    Write-Host "Saved to $logsDir\bootstrap-error.txt" -ForegroundColor Yellow
}
finally {
    if (-not $transcriptStopped) { try { Stop-Transcript | Out-Null } catch { } }
}
