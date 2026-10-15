#Requires -Version 5.1
# Encrypts or decrypts data with Windows DPAPI for the current user (host/secrets/secret-store.ts runs it). Standard
# input: base64 of the bytes; standard output: base64 of the result. Nothing goes on the command line, so nothing shows
# in a process list, and nothing is written to disk. Only this Windows user, on this PC, can decrypt what it made.
# Exit 0 on success; exit 1 with the reason on stderr.
param(
    [Parameter(Mandatory = $true)][ValidateSet('protect', 'unprotect')][string]$Mode
)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    $buffer = New-Object System.IO.MemoryStream
    [Console]::OpenStandardInput().CopyTo($buffer)
    $text = [System.Text.Encoding]::ASCII.GetString($buffer.ToArray()).Trim()
    $data = [Convert]::FromBase64String($text)
    # A fixed extra secret: another program of yours that calls DPAPI without it cannot open these.
    $entropy = [System.Text.Encoding]::UTF8.GetBytes('agent-sandbox/secret-store/v1')
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($Mode -eq 'protect') {
        $result = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)
    } else {
        $result = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope)
    }
    [Console]::Out.Write([Convert]::ToBase64String($result))
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
