#Requires -Version 5.1
# Prints, as JSON, the Windows events since -Since that can end a sandbox: restarts and shutdowns, power loss, sleep,
# low memory, this PC's blue screens, and Windows inside the sandbox crashing. Read-only. Used by host/stops.ts.
param([Parameter(Mandatory = $true)][datetime]$Since)
$ErrorActionPreference = 'Stop'

$filters = @(
    @{ LogName = 'System'; Id = 1074, 6008, 41, 42, 2004; StartTime = $Since },
    @{ LogName = 'System'; Id = 1001; ProviderName = 'Microsoft-Windows-WER-SystemErrorReporting'; StartTime = $Since },
    @{ LogName = 'Microsoft-Windows-Hyper-V-Worker-Admin'; Id = 18590, 40001; StartTime = $Since }
)
$maxMessage = 390

# What each event says beyond its id: the program that asked for a restart (1074), else the start of the message.
function Get-EventDetail($record) {
    if ($record.Id -eq 1074) { return [string]$record.Properties[0].Value }
    if ($record.Id -in 18590, 40001, 1001) {
        $message = [string]$record.Message
        return $message.Substring(0, [math]::Min($maxMessage, $message.Length))
    }
    return ''
}

$events = foreach ($filter in $filters) {
    try {
        Get-WinEvent -FilterHashtable $filter -MaxEvents 100 | ForEach-Object {
            [pscustomobject]@{
                at       = $_.TimeCreated.ToUniversalTime().ToString('o')
                id       = $_.Id
                provider = $_.ProviderName
                process  = Get-EventDetail $_
            }
        }
    } catch {
        # No matching events, or a log this PC does not have: nothing to add.
    }
}
ConvertTo-Json -Compress -InputObject @($events)
