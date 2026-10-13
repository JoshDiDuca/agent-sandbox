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
# -Encoding UTF8: Windows PowerShell 5.1 otherwise reads it in the ANSI code page (non-ASCII paths and names break).
$session = Get-Content -LiteralPath (Join-Path $launchDir 'session.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$hostVersion = [string]$session.hostTools.nodeVersion

# The functions (dot-sourced: they run in this script's scope and see its variables).
. (Join-Path $PSScriptRoot 'bootstrap\status.ps1')
. (Join-Path $PSScriptRoot 'bootstrap\files.ps1')
. (Join-Path $PSScriptRoot 'bootstrap\runner.ps1')
. (Join-Path $PSScriptRoot 'bootstrap\drives.ps1')

try {
    # First: hooks, toolchains and the agent all run in (or below) the workspace, which may be on one of these drives.
    $unmounted = Mount-MirrorDrives
    $workspaceDrive = ([string]$session.workspace).Substring(0, 1).ToUpperInvariant()
    if ($unmounted -contains $workspaceDrive) {
        throw "The workspace $($session.workspace) needs drive ${workspaceDrive}:, which could not be created in the sandbox (see the warning above). Set guestWorkspace to ""auto"" (C:\Workspace\<name>) for this project."
    }
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
        $current = Get-Content -LiteralPath (Join-Path $runDir 'sandbox.json') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
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
