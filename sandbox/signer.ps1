#Requires -Version 5.1
# Prints the subject of a file's Authenticode signature when it is valid; prints nothing when the file is unsigned or
# was tampered with (guest/toolchains/native/vcruntime.ts checks Microsoft's signature before running an installer).
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'

$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -eq 'Valid') { $signature.SignerCertificate.Subject }
