#Requires -Version 5.1
# Reads the desktop look the sandbox copies (host/profile/personalize.ts): the HKCU values named in -SpecFile (JSON,
# { "key": ["value", ...] }) and the wallpaper path, printed as JSON in UTF-8. Read-only.
param([Parameter(Mandatory = $true)][string]$SpecFile)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$spec = Get-Content -LiteralPath $SpecFile -Raw -Encoding UTF8 | ConvertFrom-Json
$out = @()
foreach ($p in $spec.PSObject.Properties) {
    $key = Get-Item -LiteralPath ('HKCU:\' + $p.Name)
    if (-not $key) { continue }
    foreach ($name in $p.Value) {
        $raw = $key.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
        if ($null -eq $raw) { continue }
        $kind = $key.GetValueKind($name).ToString()
        if ($kind -eq 'Binary') { $raw = [Convert]::ToBase64String([byte[]]$raw) }
        $out += [pscustomobject]@{ key = $p.Name; name = $name; kind = $kind; value = $raw }
    }
}
$wall = (Get-ItemProperty -LiteralPath 'HKCU:\Control Panel\Desktop').WallPaper
[pscustomobject]@{ values = $out; wallpaper = $wall } | ConvertTo-Json -Depth 5 -Compress
