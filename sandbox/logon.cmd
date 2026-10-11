@echo off
rem Windows Sandbox runs LogonCommand in a hidden window, so this file opens a VISIBLE PowerShell for the real work.
if not exist C:\AgentData\logs mkdir C:\AgentData\logs
echo logon.cmd ran at %date% %time% > C:\AgentData\logs\logon-hit.txt
start "Agent Sandbox" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File C:\AgentLaunch\sandbox\bootstrap.ps1
