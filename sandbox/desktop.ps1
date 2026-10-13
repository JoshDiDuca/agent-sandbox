#Requires -Version 5.1
# Applies the desktop look imported from the PC (guest/setup/desktop.ts): the wallpaper copied in, then Explorer
# restarts (it starts again by itself) so taskbar and theme changes show.
param([string]$Wallpaper = '')
$ErrorActionPreference = 'Stop'

if ($Wallpaper) {
    Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name WallPaper -Value $Wallpaper
    Add-Type -Path (Join-Path $PSScriptRoot 'desktop.cs')
    try {
        [AgentSandbox.Desk]::SetWallpaper($Wallpaper)
    } catch {
        # The registry value above still applies at the next sign-in.
    }
}
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
