#Requires -Version 5.1
# Runs INSIDE Windows Sandbox (Windows PowerShell 5.1), started by logon.cmd in a visible window.
# Its only job is to make sure a persistent Node exists, then hand over to guest\main.js.
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
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
Write-Host 'Agent sandbox bootstrap started.' -ForegroundColor Cyan
$transcript = Join-Path $logsDir ('bootstrap-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
Start-Transcript -Path $transcript | Out-Null
$transcriptStopped = $false

function Invoke-Download {
    param([string]$Uri, [string]$OutFile)
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

function Publish-Directory {
    param([string]$Staging, [string]$Destination)
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    Move-Item -LiteralPath $Staging -Destination $Destination
}

function Copy-NodeFromHost {
    if (-not (Test-Path -LiteralPath (Join-Path $hostNode 'node.exe'))) { return $false }
    Write-Host "Copying Node from this PC ($hostNode) ..."
    $staging = Join-Path $toolsDir 'node-staging'
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    & robocopy.exe $hostNode $staging /E /NFL /NDL /NJH /NJS /NP | Out-Null
    $code = $LASTEXITCODE
    $global:LASTEXITCODE = 0
    if ($code -ge 8) { Write-Warning "robocopy failed with exit code $code"; return $false }
    Publish-Directory -Staging $staging -Destination $nodeDir
    return (Test-Node)
}

function Install-NodeFromWeb {
    param([string]$Wanted)
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    Write-Host 'Looking up Node release ...'
    $index = (Invoke-Download -Uri 'https://nodejs.org/dist/index.json') | ConvertFrom-Json
    $release = $null
    foreach ($candidate in $index) {
        $isWanted = if ($Wanted -eq 'lts') { [bool]$candidate.lts } else { $candidate.version -eq $Wanted }
        if ($isWanted -and ($candidate.files -contains "win-$arch-zip")) { $release = $candidate; break }
    }
    if ($null -eq $release) { throw "No Node release found for '$Wanted' ($arch)." }
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
        Write-Host 'Extracting Node ...'
        $extractDir = Join-Path $work 'extracted'
        New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
        $extracted = $false
        try { & tar.exe -xf $zipPath -C $extractDir; $extracted = ($LASTEXITCODE -eq 0) } catch { $extracted = $false }
        $global:LASTEXITCODE = 0
        if (-not $extracted) { Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force }
        $inner = Join-Path $extractDir "node-$version-win-$arch"
        if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe'))) { throw 'Unexpected Node archive layout.' }
        Publish-Directory -Staging $inner -Destination $nodeDir
    }
    finally {
        if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

try {
    $session = Get-Content -LiteralPath (Join-Path $launchDir 'session.json') -Raw | ConvertFrom-Json
    $provisioning = $session.provisioning

    if ((Test-Node) -and -not $provisioning.refresh) {
        Write-Host ('Node ' + (& $nodeExe --version) + ' already cached in persistent storage.')
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
        if (-not $ready) { Install-NodeFromWeb -Wanted ([string]$provisioning.node.version) }
        if (-not (Test-Node)) { throw 'Node is not runnable after provisioning.' }
        Write-Host ('Node ' + (& $nodeExe --version) + ' ready.')
    }

    $env:PATH = "$nodeDir;$env:PATH"
    Set-Location -LiteralPath $session.workspace
    Stop-Transcript | Out-Null
    $transcriptStopped = $true
    & $nodeExe (Join-Path $launchDir 'guest\main.js')
    Write-Host "guest runner finished (exit code $LASTEXITCODE). This window stays open in $($session.workspace)."
}
catch {
    $report = ($_ | Format-List * -Force | Out-String) + "`r`n" + $_.ScriptStackTrace
    Set-Content -Path (Join-Path $logsDir 'bootstrap-error.txt') -Value $report -Encoding UTF8
    Write-Host $report -ForegroundColor Red
    Write-Host "Saved to $logsDir\bootstrap-error.txt" -ForegroundColor Yellow
}
finally {
    if (-not $transcriptStopped) { try { Stop-Transcript | Out-Null } catch { } }
}
