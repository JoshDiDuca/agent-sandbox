#Requires -Version 5.1
# Runs INSIDE Windows Sandbox (Windows PowerShell 5.1) in the sandbox window, started by logon.cmd.
# Its only job: make sure the runner's Node exists in persistent storage, then hand over to runtime\main.js.
# (That Node only runs agent-sandbox itself; the agent's `node` comes from nvm.)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # progress bars make PS 5.1 downloads extremely slow
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$launchDir = 'C:\AgentLaunch'
$dataDir = 'C:\AgentData'
$hostNode = 'C:\HostTools\node'
$toolsDir = Join-Path $dataDir 'tools'
$nodeDir = Join-Path $toolsDir 'node'
$nodeExe = Join-Path $nodeDir 'node.exe'
$logsDir = Join-Path $dataDir 'logs'
$runDir = Join-Path $dataDir 'run'
foreach ($dir in @($logsDir, $toolsDir, $runDir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$host.UI.RawUI.WindowTitle = 'Agent Sandbox'
Write-Host 'Agent sandbox bootstrap started.' -ForegroundColor Cyan
$transcript = Join-Path $logsDir ('bootstrap-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
Start-Transcript -Path $transcript | Out-Null
$transcriptStopped = $false
$session = Get-Content -LiteralPath (Join-Path $launchDir 'session.json') -Raw | ConvertFrom-Json

function Set-Status([string]$Phase, [string]$Message) {
    # Same shape as SandboxStatus in src/types.ts; written atomically so the host never reads half a file.
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

function Test-Node {
    if (-not (Test-Path -LiteralPath $nodeExe)) { return $false }
    try { $null = & $nodeExe --version; return ($LASTEXITCODE -eq 0) } catch { return $false }
}

function Publish-Directory([string]$Staging, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    Move-Item -LiteralPath $Staging -Destination $Destination
}

function Copy-NodeFromHost {
    if (-not (Test-Path -LiteralPath (Join-Path $hostNode 'node.exe'))) { return $false }
    Write-Host "Copying Node from this PC ($hostNode) ..."
    $staging = Join-Path $toolsDir 'node-staging'
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    & robocopy.exe $hostNode $staging /E /NFL /NDL /NJH /NJS /NP | Out-Null
    $code = $LASTEXITCODE
    $global:LASTEXITCODE = 0
    if ($code -ge 8) { Write-Warning "robocopy failed with exit code $code"; return $false }
    Publish-Directory -Staging $staging -Destination $nodeDir
    return (Test-Node)
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
        Publish-Directory -Staging $inner -Destination $nodeDir
    }
    finally {
        if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

try {
    Set-Status 'booting' 'Preparing the runner'
    $provisioning = $session.provisioning
    if ((Test-Node) -and -not $provisioning.refresh) {
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

    $env:PATH = "$nodeDir;$env:PATH"
    Set-Location -LiteralPath $session.workspace
    Stop-Transcript | Out-Null
    $transcriptStopped = $true
    & $nodeExe (Join-Path $launchDir 'runtime\main.js')
    Write-Host "Sandbox runner finished (exit code $LASTEXITCODE). This window stays open in $($session.workspace)."
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
