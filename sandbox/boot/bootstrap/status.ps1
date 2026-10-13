# The boot status the host waits on (run\sandbox.json), for bootstrap.ps1 (dot-sourced).
function Set-Status([string]$Phase, [string]$Message) {
    # Same shape as SandboxStatus in src/shared/schema.ts; written atomically so the host never reads half a file.
    $status = [ordered]@{ launchId = $session.launchId; phase = $Phase; message = $Message; updatedAt = (Get-Date).ToUniversalTime().ToString('o'); workspaceHost = $session.workspaceHost; guestWorkspace = $session.workspace; headless = [bool]$session.headless }
    $file = Join-Path $runDir 'sandbox.json'
    [IO.File]::WriteAllText("$file.tmp", ($status | ConvertTo-Json -Compress))
    Move-Item -LiteralPath "$file.tmp" -Destination $file -Force
}
