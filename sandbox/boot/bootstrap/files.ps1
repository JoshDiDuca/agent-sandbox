# Downloads, copies and folder moves for bootstrap.ps1 (dot-sourced).
function Invoke-Download([string]$Uri, [string]$OutFile) {
    # The sandbox network can take a few seconds to come up, so retry.
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            if ($OutFile) { Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing; return $null }
            $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing
            if ($response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($response.Content) }
            return [string]$response.Content
        }
        catch {
            if ($attempt -eq 5) { throw }
            Write-Warning "Download failed (attempt $attempt of 5): $($_.Exception.Message). Retrying ..."
            Start-Sleep -Seconds 4
        }
    }
}

function Publish-Directory([string]$Staging, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    Move-Item -LiteralPath $Staging -Destination $Destination
}

function Get-Size([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { return 0 } else { return [long]$sum }
}

function Invoke-Robocopy([string]$Label, [string]$From, [string]$To, [string[]]$Options, [long]$Total) {
    # Runs robocopy in the background and prints how far it has got, so a slow copy never looks frozen.
    # /R:2 /W:1: robocopy's default is 1,000,000 retries 30 s apart, which hangs "forever" on one unreadable file.
    $totalMb = [math]::Round($Total / 1MB, 1)
    Write-Host "  $Label ($totalMb MB) ..."
    $argList = @("`"$From`"", "`"$To`"") + $Options + @('/XJ', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    $process = Start-Process -FilePath 'robocopy.exe' -ArgumentList $argList -NoNewWindow -PassThru
    $null = $process.Handle   # keeps ExitCode readable after the process exits
    $started = Get-Date
    while (-not $process.WaitForExit(2000)) {
        $done = Get-Size $To
        $pct = if ($Total -gt 0) { [math]::Min(100, [math]::Floor($done * 100 / $Total)) } else { 0 }
        $secs = [int]((Get-Date) - $started).TotalSeconds
        Write-Host ("  {0}: {1} of {2} MB ({3}%), {4}s" -f $Label, [math]::Round($done / 1MB, 1), $totalMb, $pct, $secs)
    }
    $code = $process.ExitCode
    if ($code -ge 8) { Write-Warning "robocopy failed copying $Label (exit code $code)"; return $false }
    Write-Host ("  {0}: done in {1}s" -f $Label, [int]((Get-Date) - $started).TotalSeconds)
    return $true
}
