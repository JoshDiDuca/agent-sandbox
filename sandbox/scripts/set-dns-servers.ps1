#Requires -Version 5.1
# network.dns: these DNS servers on every connected adapter (guest/network/firewall.ts). -Servers is a comma-separated
# list of IPv4 addresses, checked by the runtime.
param([Parameter(Mandatory = $true)][string]$Servers)
$ErrorActionPreference = 'Stop'

$addresses = @($Servers -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
Get-NetAdapter | Where-Object Status -eq 'Up' | Set-DnsClientServerAddress -ServerAddresses $addresses
