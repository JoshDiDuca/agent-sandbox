#Requires -Version 5.1
# Machine-wide environment variables and PATH folders, so every new terminal tab and anything an agent starts sees the
# same tools (guest/setup/environment.ts). -SettingsFile is JSON written by the runtime:
#   vars: { name: value }   set machine-wide (with additive: only the ones not set yet)
#   path: string | null      replaces the machine PATH
#   add: [folders]           added to PATH when missing: in front, or (additive) at the end
param([Parameter(Mandatory = $true)][string]$SettingsFile)
$ErrorActionPreference = 'Stop'

$settings = Get-Content -LiteralPath $SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$additive = [bool]$settings.additive

foreach ($variable in $settings.vars.PSObject.Properties) {
    if ($additive -and [Environment]::GetEnvironmentVariable($variable.Name, 'Machine')) { continue }
    [Environment]::SetEnvironmentVariable($variable.Name, [string]$variable.Value, 'Machine')
}

if ($null -ne $settings.path) {
    [Environment]::SetEnvironmentVariable('Path', [string]$settings.path, 'Machine')
}

if ($settings.add) {
    $current = [Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';'
    $missing = @($settings.add | Where-Object { $current -notcontains $_ })
    if ($missing.Count) {
        $combined = if ($additive) { $current + $missing } else { $missing + $current }
        [Environment]::SetEnvironmentVariable('Path', ($combined -join ';'), 'Machine')
    }
}
