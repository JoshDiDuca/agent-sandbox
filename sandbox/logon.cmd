@echo off
rem Windows Sandbox runs LogonCommand in a hidden window, so this opens the VISIBLE sandbox window: Windows Terminal
rem (downloaded once by the host into persistent storage), or a plain PowerShell window if it is not available.
if not exist C:\AgentData\logs mkdir C:\AgentData\logs
echo logon.cmd ran at %date% %time% > C:\AgentData\logs\logon-hit.txt
call C:\AgentLaunch\sandbox\trust.cmd
set "BOOT=powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File C:\AgentLaunch\sandbox\bootstrap.ps1"
if exist C:\AgentData\tools\terminal\wt.exe (
  start "" C:\AgentData\tools\terminal\wt.exe --maximized new-tab --title "Agent Sandbox" -d C:\AgentLaunch %BOOT%
) else (
  start "Agent Sandbox" %BOOT%
)
