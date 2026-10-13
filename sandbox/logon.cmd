@echo off
rem Windows Sandbox runs LogonCommand in a hidden window, so this opens the VISIBLE sandbox window: Windows Terminal
rem (downloaded once by the host into persistent storage), or a plain PowerShell window if it is missing or fails.
if not exist C:\AgentData\logs mkdir C:\AgentData\logs
echo logon.cmd ran at %date% %time% > C:\AgentData\logs\logon-hit.txt
call C:\AgentLaunch\sandbox\trust.cmd
rem New Terminal tabs start in %AGENT_WORKSPACE%: Terminal must have it before the runtime sets it machine-wide.
if exist C:\AgentLaunch\env.cmd call C:\AgentLaunch\env.cmd
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
rem sandbox.cpuLimit: this window joins a CPU-capped job first, so everything started below inherits the cap.
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\AgentLaunch\sandbox\cpucap.ps1
rem sandbox.pageFileMb: room for many parallel builds (the sandbox starts with about 1 GB of paging file).
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\AgentLaunch\sandbox\pagefile.ps1
set "BOOT=%PS% -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File C:\AgentLaunch\sandbox\bootstrap.ps1"
if not exist C:\AgentData\tools\terminal\wt.exe goto plain
start "" C:\AgentData\tools\terminal\wt.exe --maximized new-tab --title "Agent Sandbox" -d C:\AgentLaunch %BOOT%
rem If Windows Terminal could not start, fall back to PowerShell so there is always a window.
%SystemRoot%\System32\timeout.exe /t 10 /nobreak >nul
%SystemRoot%\System32\tasklist.exe /fi "imagename eq WindowsTerminal.exe" | %SystemRoot%\System32\find.exe /i "WindowsTerminal" >nul && exit /b 0
echo Windows Terminal did not start; using PowerShell. >> C:\AgentData\logs\logon-hit.txt
:plain
start "Agent Sandbox" %BOOT%
