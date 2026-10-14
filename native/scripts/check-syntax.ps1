#Requires -Version 5.1
# Parses a PowerShell script without running it (the self-test uses it on native\scripts). Exit 0 when it parses, 1
# with the parse errors on stderr otherwise.
param(
    [Parameter(Mandatory = $true)][string]$Path
)
$ErrorActionPreference = 'Stop'

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
if ($errors.Count -eq 0) { exit 0 }
foreach ($e in $errors) { [Console]::Error.WriteLine($e.Message) }
exit 1
