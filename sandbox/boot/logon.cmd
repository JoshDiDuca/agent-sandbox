@echo off
rem Windows Sandbox runs LogonCommand in a hidden window, so this opens the VISIBLE sandbox window: Windows Terminal
rem (downloaded once by the host into persistent storage), or a plain PowerShell window if it is missing or fails.
if not exist C:\AgentData\logs mkdir C:\AgentData\logs
echo logon.cmd ran at %date% %time% > C:\AgentData\logs\logon-hit.txt
call C:\AgentLaunch\sandbox\boot\trust.cmd
rem New Terminal tabs start in %AGENT_WORKSPACE%: Terminal must have it before the runtime sets it machine-wide.
if exist C:\AgentLaunch\env.cmd call C:\AgentLaunch\env.cmd
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
rem SandboxTools.exe (sandbox\csharp\SandboxTools), built once per boot on the sandbox's own disk (no window: winexe).
set "TOOLS=%TEMP%\agent-sandbox\SandboxTools.exe"
if not exist "%TEMP%\agent-sandbox" mkdir "%TEMP%\agent-sandbox"
if not exist "%TOOLS%" "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize /target:winexe /out:"%TOOLS%" C:\AgentLaunch\sandbox\csharp\SandboxTools\*.cs >> C:\AgentData\logs\logon-hit.txt 2>&1
if not exist "%TOOLS%" goto tools_done
rem sandbox.cpuLimit: this window joins a CPU-capped job first, so everything started below inherits the cap.
"%TOOLS%" cpu-cap
rem sandbox.pageFileMb: room for many parallel builds (the sandbox starts with about 1 GB of paging file).
"%TOOLS%" page-file
rem The memory state every 30 s into the persistent logs, so a crash leaves evidence.
start "" "%TOOLS%" memory-log
:tools_done
set "BOOT=%PS% -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File C:\AgentLaunch\sandbox\boot\bootstrap.ps1"
if not exist C:\AgentData\tools\terminal\wt.exe goto plain
start "" C:\AgentData\tools\terminal\wt.exe --maximized new-tab --title "Agent Sandbox" -d C:\AgentLaunch %BOOT%
rem If Windows Terminal could not start, fall back to PowerShell so there is always a window.
%SystemRoot%\System32\timeout.exe /t 10 /nobreak >nul
%SystemRoot%\System32\tasklist.exe /fi "imagename eq WindowsTerminal.exe" | %SystemRoot%\System32\find.exe /i "WindowsTerminal" >nul && exit /b 0
echo Windows Terminal did not start; using PowerShell. >> C:\AgentData\logs\logon-hit.txt
:plain
start "Agent Sandbox" %BOOT%
