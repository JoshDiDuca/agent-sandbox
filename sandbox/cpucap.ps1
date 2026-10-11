#Requires -Version 5.1
# Caps how much of the PC's CPU the sandbox may use (sandbox.cpuLimit). Windows Sandbox has no CPU setting and gets
# every processor, so heavy builds inside can take the whole PC. This puts logon.cmd (the parent of this script),
# before it starts anything, into a Windows job object with a hard CPU-rate cap; everything it starts inherits it:
# Windows Terminal and its tabs, the boot, the agents, installs and builds. Programs started from the sandbox's Start
# menu are not covered. Never stops the boot: any problem is logged and the sandbox starts uncapped.
param([int]$ProcessId = 0, [int]$Percent = 0)
$ErrorActionPreference = 'Stop'
$log = 'C:\AgentData\logs\logon-hit.txt'
try {
    if ($Percent -eq 0) {
        $session = Get-Content -LiteralPath 'C:\AgentLaunch\session.json' -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $session.cpuLimitPercent) { exit 0 }
        $Percent = [int]$session.cpuLimitPercent
    }
    if ($Percent -lt 1 -or $Percent -ge 100) { exit 0 }
    if ($ProcessId -eq 0) { $ProcessId = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SandboxCpuCap {
    [StructLayout(LayoutKind.Sequential)]
    private struct CpuRate { public uint ControlFlags; public uint Rate; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref CpuRate info, int length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    // JobObjectCpuRateControlInformation; ENABLE | HARD_CAP; the rate is in 1/100 % of all processors.
    public static void Apply(int pid, int percent) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        CpuRate rate = new CpuRate();
        rate.ControlFlags = 0x1 | 0x4;
        rate.Rate = (uint)(percent * 100);
        if (!SetInformationJobObject(job, 15, ref rate, Marshal.SizeOf(typeof(CpuRate)))) throw new Win32Exception();
        // PROCESS_SET_QUOTA | PROCESS_TERMINATE: what AssignProcessToJobObject needs.
        IntPtr process = OpenProcess(0x0100 | 0x0001, false, pid);
        if (process == IntPtr.Zero) throw new Win32Exception();
        try { if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(); } finally { CloseHandle(process); }
        // The job's handle may close: it lives on while any process in it runs.
    }
}
'@
    [SandboxCpuCap]::Apply($ProcessId, $Percent)
    "CPU capped at $Percent% of the PC (sandbox.cpuLimit)." | Add-Content -LiteralPath $log
} catch {
    "CPU cap not applied (the sandbox runs uncapped): $($_.Exception.Message)" | Add-Content -LiteralPath $log
}
exit 0
