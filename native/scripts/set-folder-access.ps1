#Requires -Version 5.1
# Adds or removes folder access entries listed in a JSON file (host/sharing/acl.ts writes it): { "changes": [ { path,
# sid, rights (Read | Traverse | Modify), scope (this-folder | inherit), add } ] }. Entries are applied in order.
# A link (junction or symbolic link) is refused, so an entry can never land on another folder. Exit 0 when all are
# applied; exit 1 with the reason on stderr otherwise.
param(
    [Parameter(Mandatory = $true)][string]$Json
)
$ErrorActionPreference = 'Stop'

try {
    # The entries sit in a property: piping a bare JSON array into ConvertFrom-Json gives one array object on 5.1.
    $doc = Get-Content -LiteralPath $Json -Raw -Encoding UTF8 | ConvertFrom-Json
    $entries = @($doc.changes)
    foreach ($e in $entries) {
        if ($e.rights -notin @('Read', 'Traverse', 'Modify')) { throw "Unknown rights: $($e.rights)" }
        if ($e.scope -notin @('this-folder', 'inherit')) { throw "Unknown scope: $($e.scope)" }
        $item = Get-Item -LiteralPath $e.path -Force
        if (-not $item.PSIsContainer) { throw "Not a folder: $($e.path)" }
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Refusing a link: $($e.path)" }

        $sid = New-Object System.Security.Principal.SecurityIdentifier($e.sid)
        $rights = [System.Security.AccessControl.FileSystemRights]$e.rights
        if ($e.scope -eq 'inherit') {
            $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        } else {
            $inherit = [System.Security.AccessControl.InheritanceFlags]'None'
        }
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid, $rights, $inherit, [System.Security.AccessControl.PropagationFlags]'None', [System.Security.AccessControl.AccessControlType]'Allow')

        $acl = Get-Acl -LiteralPath $e.path
        if ($e.add) {
            $acl.AddAccessRule($rule)
        } else {
            [void]$acl.RemoveAccessRuleSpecific($rule)
        }
        Set-Acl -LiteralPath $e.path -AclObject $acl
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
