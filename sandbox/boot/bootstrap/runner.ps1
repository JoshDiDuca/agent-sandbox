# The runner's Node in persistent storage (cached, copied from this PC, or downloaded), for bootstrap.ps1 (dot-sourced).
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
    $last = if (Test-Path -LiteralPath $runnerFile) { (Get-Content -LiteralPath $runnerFile -Raw -Encoding UTF8).Trim() } else { '' }
    foreach ($version in @($hostVersion, $last)) {
        if ($version -notmatch '^\d+\.\d+\.\d+$') { continue }
        Set-Runner $version
        if (Test-Node) { return $true }
    }
    return $false
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
