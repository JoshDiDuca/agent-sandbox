#Requires -Version 5.1
# Creates .lnk shortcuts (desktop, Start menu) in one call (guest/apps, the VS Code step). -ListFile is JSON written by
# the runtime: [{ link, target, workingDirectory?, arguments? }].
param([Parameter(Mandatory = $true)][string]$ListFile)
$ErrorActionPreference = 'Stop'

$shell = New-Object -ComObject WScript.Shell
foreach ($entry in @(Get-Content -LiteralPath $ListFile -Raw -Encoding UTF8 | ConvertFrom-Json)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $entry.link) | Out-Null
    $shortcut = $shell.CreateShortcut($entry.link)
    $shortcut.TargetPath = $entry.target
    if ($entry.workingDirectory) { $shortcut.WorkingDirectory = $entry.workingDirectory }
    if ($entry.arguments) { $shortcut.Arguments = $entry.arguments }
    $shortcut.Save()
}
