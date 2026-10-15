#Requires -Version 5.1
# Every new shell starts with the CURRENT machine + user PATH, whatever its parent had: tools added later in the boot
# (python, rust, pwsh, agents ...) reach Windows Terminal tabs, Explorer launches and every other shell this way. The
# start-up files call pathsync.exe (sandbox\csharp\PathSync.cs, built each boot):
#   Windows PowerShell and PowerShell 7: the all-users profile.ps1
#   cmd.exe: HKLM\Software\Microsoft\Command Processor AutoRun -> shell-path.cmd (does nothing for `cmd /c`)
#   Git Bash: etc\profile.d\agent-sandbox-path.sh
# -Helper is pathsync.exe. -PwshDir and -GitRoot are optional. -Root writes under that folder instead of the machine
# (tests): no registry is touched then.
param(
    [Parameter(Mandatory = $true)][string]$Helper,
    [string]$PwshDir = '',
    [string]$GitRoot = '',
    [string]$Root = ''
)
$ErrorActionPreference = 'Stop'

$marker = 'agent-sandbox path sync'

function Write-Ours([string]$file, [string]$text) {
    if (Test-Path -LiteralPath $file) {
        if (-not (Select-String -LiteralPath $file -SimpleMatch $marker -Quiet)) { return }
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
    }
    [IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding($false)))
}

$profileText = "# $marker`r`n" +
    "try { `$p = & '$Helper'; if (`$p) { `$env:Path = `$p } } catch { }`r`n"

$windowsProfileDir = if ($Root) { Join-Path $Root 'windowspowershell' } else { Join-Path $env:windir 'System32\WindowsPowerShell\v1.0' }
Write-Ours (Join-Path $windowsProfileDir 'profile.ps1') $profileText
if ($PwshDir -and (Test-Path -LiteralPath $PwshDir)) { Write-Ours (Join-Path $PwshDir 'profile.ps1') $profileText }

# cmd: interactive only. `cmd /c ...` (what programs and for /f start) has /c in its command line and leaves at once, which
# also stops the loop of the for /f below.
$cmdFile = Join-Path (Split-Path -Parent $Helper) 'shell-path.cmd'
$cmdText = "@echo off`r`n" +
    "rem $marker`r`n" +
    "setlocal enabledelayedexpansion`r`n" +
    "set `"_L=!cmdcmdline!`"`r`n" +
    "if not `"!_L:/c=!`"==`"!_L!`" exit /b 0`r`n" +
    "if not `"!_L:/r=!`"==`"!_L!`" exit /b 0`r`n" +
    "set `"_P=`"`r`n" +
    "for /f `"delims=`" %%P in ('`"$Helper`"') do set `"_P=%%P`"`r`n" +
    "if not defined _P exit /b 0`r`n" +
    "endlocal & set `"PATH=%_P%`"`r`n"
if (-not (Test-Path -LiteralPath $cmdFile) -or (Select-String -LiteralPath $cmdFile -SimpleMatch $marker -Quiet)) {
    [IO.File]::WriteAllText($cmdFile, $cmdText, [Text.Encoding]::ASCII)
}
if (-not $Root) {
    $key = 'HKLM:\Software\Microsoft\Command Processor'
    $current = (Get-ItemProperty -Path $key -Name AutoRun -ErrorAction SilentlyContinue).AutoRun
    if (-not $current -or $current -like '*shell-path.cmd*') {
        if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
        Set-ItemProperty -Path $key -Name AutoRun -Value "if exist `"$cmdFile`" call `"$cmdFile`""
    }
}

if ($GitRoot -and (Test-Path -LiteralPath (Join-Path $GitRoot 'etc\profile.d'))) {
    $posixHelper = $Helper -replace '\\', '/'
    $shText = "# $marker`n" +
        "_w=`"`$('$posixHelper' 2>/dev/null)`"`n" +
        "if [ -n `"`$_w`" ]; then`n" +
        "  _n=`"`$(cygpath -u -p `"`$_w`" 2>/dev/null)`"`n" +
        "  _o=`$IFS; IFS=:`n" +
        "  for _d in `$_n; do case `":`$PATH:`" in *`":`$_d:`"*) ;; *) PATH=`"`$PATH:`$_d`" ;; esac; done`n" +
        "  IFS=`$_o; export PATH`n" +
        "fi`n" +
        "unset _w _n _o _d`n"
    Write-Ours (Join-Path $GitRoot 'etc\profile.d\agent-sandbox-path.sh') $shText
}
