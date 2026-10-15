#Requires -Version 5.1
# Prints the permissions of a folder (and of a second path when given) as SDDL, one line each, read only. Used by the
# self-test to compare a folder and a child before and after a change ("D:AI" = auto-inherited).
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Also
)
$ErrorActionPreference = 'Stop'
(Get-Acl -LiteralPath $Path).Sddl
if ($Also) { (Get-Acl -LiteralPath $Also).Sddl }
