# Drive letters D: to Z: for mirrored guest paths (subst), for bootstrap.ps1 (dot-sourced).
function Mount-MirrorDrives {
    # Windows Sandbox can only map folders onto C:, so a guest path like F:\Games\X is mapped to C:\Mirror\F\Games\X
    # and F: is made here with subst (session.substDrives, written by the host; see src/shared/guest-paths.ts).
    # subst drives belong to the logon session: everything started from here (main.js, the daemon, ptyhost, hooks,
    # Windows Terminal tabs) and Explorer share it, because the sandbox user has one full token (UAC is off).
    # Returns the letters that could NOT be mounted; an existing drive is reported, never replaced.
    $subst = Join-Path $env:SystemRoot 'System32\subst.exe'
    $failed = @()
    foreach ($drive in @($session.substDrives)) {
        if ($null -eq $drive) { continue }
        $letter = ([string]$drive.letter).ToUpperInvariant()
        $target = [string]$drive.target
        if ($letter -notmatch '^[D-Z]$' -or $target -ne "C:\Mirror\$letter") { throw "Invalid subst drive in session.json: '$letter' -> '$target'." }
        $existing = (& $subst) | ForEach-Object { if ($_ -match "^${letter}:\\: => (.+)$") { $Matches[1].Trim() } } | Select-Object -First 1
        if ($existing -and $existing -eq $target) { Write-Host "  ${letter}: already points to $target."; continue }
        if ([IO.Directory]::GetLogicalDrives() | Where-Object { $_.Substring(0, 1).ToUpperInvariant() -eq $letter }) {
            Write-Warning "Drive ${letter}: already exists in the sandbox, so it was left alone. Folders mapped to ${letter}:\... are at $target\... instead."
            $failed += $letter
            continue
        }
        if (-not (Test-Path -LiteralPath $target -PathType Container)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
        # subst.exe exits 0 even when it fails, so check the drive itself.
        & $subst "${letter}:" $target | Out-Host
        if (Test-Path -LiteralPath "${letter}:\") { Write-Host "  ${letter}: -> $target" }
        else { Write-Warning "subst ${letter}: $target did not work. Folders mapped to ${letter}:\... are at $target\... instead."; $failed += $letter }
    }
    return ,$failed
}
