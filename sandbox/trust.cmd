@echo off
rem Runs first at logon, INSIDE the disposable sandbox only (the host PC is never touched).
rem Lets the sandbox's own tools run without "Open File - Security Warning", SmartScreen, script-policy or UAC prompts.
rem The security boundary is Windows Sandbox itself plus workspace-only write access and the LAN block; these prompts add
rem nothing inside a throwaway VM except interruptions.
set "POL=HKCU\Software\Microsoft\Windows\CurrentVersion\Policies"
reg add "%POL%\Associations" /v LowRiskFileTypes /t REG_SZ /d ".exe;.com;.cmd;.bat;.ps1;.psm1;.msi;.vbs;.js;.zip;.7z" /f >nul
reg add "%POL%\Attachments" /v SaveZoneInformation /t REG_DWORD /d 1 /f >nul
rem Mapped folders and UNC paths count as Local Intranet, where launching programs is allowed without asking.
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap" /v UNCAsIntranet /t REG_DWORD /d 1 /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap" /v IntranetName /t REG_DWORD /d 1 /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Zones\1" /v 1806 /t REG_DWORD /d 0 /f >nul
rem SmartScreen ("Windows protected your PC") for downloaded, unsigned tools.
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\System" /v EnableSmartScreen /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer" /v SmartScreenEnabled /t REG_SZ /d Off /f >nul 2>&1
rem PowerShell scripts (hooks, installers) run without the "Do you want to run ..." question.
reg add "HKLM\SOFTWARE\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell" /v ExecutionPolicy /t REG_SZ /d Bypass /f >nul 2>&1
reg add "HKCU\SOFTWARE\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell" /v ExecutionPolicy /t REG_SZ /d Bypass /f >nul
rem Elevation requests from the (already admin) sandbox user are granted without a dialog.
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v ConsentPromptBehaviorAdmin /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v PromptOnSecureDesktop /t REG_DWORD /d 0 /f >nul 2>&1
exit /b 0
