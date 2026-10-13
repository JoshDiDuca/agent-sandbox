// Caps a process and everything it starts at a share of the PC's CPU. Loaded by cpucap.ps1 (Add-Type). C# 5.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SandboxCpuCap {
    // JOBOBJECT_CPU_RATE_CONTROL_INFORMATION.
    [StructLayout(LayoutKind.Sequential)]
    private struct CpuRate { public uint ControlFlags; public uint Rate; }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref CpuRate info, int length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private const int JobObjectCpuRateControlInformation = 15;
    private const uint CpuRateEnable = 0x1, CpuRateHardCap = 0x4;
    private const uint ProcessTerminate = 0x0001, ProcessSetQuota = 0x0100;  // what AssignProcessToJobObject needs

    /// <summary>Puts process pid in a new job with a hard cap of percent % of all processors. Throws on failure.</summary>
    public static void Apply(int pid, int percent) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        // The rate is in 1/100 % of all processors.
        CpuRate rate = new CpuRate { ControlFlags = CpuRateEnable | CpuRateHardCap, Rate = (uint)(percent * 100) };
        if (!SetInformationJobObject(job, JobObjectCpuRateControlInformation, ref rate, Marshal.SizeOf(typeof(CpuRate)))) throw new Win32Exception();
        IntPtr process = OpenProcess(ProcessSetQuota | ProcessTerminate, false, pid);
        if (process == IntPtr.Zero) throw new Win32Exception();
        try { if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(); } finally { CloseHandle(process); }
        // The job's handle is left to close with this process: the job lives on while any process in it runs.
    }
}
