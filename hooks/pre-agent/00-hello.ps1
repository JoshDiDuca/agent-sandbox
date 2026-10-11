# Example pre-agent hook (runs inside the sandbox before the agent starts).
# Environment: AGENT_WORKSPACE, AGENT_DATA, AGENT_TOOLS, AGENT_PROJECT.
# Add your own code here, or drop more .ps1 / .mjs / .cmd files in this folder (they run in name order).
Write-Host "[hook] workspace = $env:AGENT_WORKSPACE | project = $env:AGENT_PROJECT"
Write-Host "[hook] user      = $(whoami)"
