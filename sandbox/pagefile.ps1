#Requires -Version 5.1
# Lets the sandbox's paging file grow (sandbox.pageFileMb). Windows Sandbox starts with about 1 GB of it, so several
# parallel builds run out of commit ("The paging file is too small", os error 1455) long before RAM is full. Growing
# a paging file takes effect at once (no restart), and the file only takes disk space once Windows needs it. Never
# stops the boot: any problem is logged and the sandbox keeps Windows' own paging file.
param([int]$MaxMb = 0)
$ErrorActionPreference = 'Stop'
$log = 'C:\AgentData\logs\logon-hit.txt'
try {
    if ($MaxMb -eq 0) {
        $session = Get-Content -LiteralPath 'C:\AgentLaunch\session.json' -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $session.pageFileMb) { exit 0 }
        $MaxMb = [int]$session.pageFileMb
    }
    if ($MaxMb -le 0) { exit 0 }
    # Keep 8 GB of the sandbox's disk free for everything else.
    $freeMb = [math]::Floor((Get-PSDrive -Name C).Free / 1MB)
    $MaxMb = [math]::Min($MaxMb, $freeMb - 8192)
    if ($MaxMb -lt 1024) { "Paging file left as it is: too little free disk." | Add-Content -LiteralPath $log; exit 0 }
    $MinMb = [math]::Min(4096, $MaxMb)
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SandboxPageFile {
    [StructLayout(LayoutKind.Sequential)] private struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] private struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] private struct TokenPrivileges { public uint Count; public Luid Luid; public uint Attributes; }
    [DllImport("ntdll.dll")] private static extern int NtCreatePagingFile(ref UnicodeString name, ref long minimum, ref long maximum, uint priority);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, int length, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    // The same call Windows makes at startup; growing the existing C:\pagefile.sys applies at once.
    public static void Grow(long minimumBytes, long maximumBytes) {
        IntPtr token;
        // TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY; SE_PRIVILEGE_ENABLED.
        if (!OpenProcessToken(GetCurrentProcess(), 0x20 | 0x8, out token)) throw new Win32Exception();
        try {
            TokenPrivileges privileges = new TokenPrivileges();
            privileges.Count = 1;
            privileges.Attributes = 2;
            if (!LookupPrivilegeValue(null, "SeCreatePagefilePrivilege", out privileges.Luid)) throw new Win32Exception();
            if (!AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
        } finally { CloseHandle(token); }
        string path = "\\??\\C:\\pagefile.sys";
        UnicodeString name = new UnicodeString();
        name.Buffer = Marshal.StringToHGlobalUni(path);
        name.Length = (ushort)(path.Length * 2);
        name.MaximumLength = (ushort)(name.Length + 2);
        try {
            int status = NtCreatePagingFile(ref name, ref minimumBytes, ref maximumBytes, 0);
            if (status != 0) throw new Exception("NtCreatePagingFile returned 0x" + status.ToString("X8"));
        } finally { Marshal.FreeHGlobal(name.Buffer); }
    }
}
'@
    [SandboxPageFile]::Grow([long]$MinMb * 1MB, [long]$MaxMb * 1MB)
    "Paging file may grow to $MaxMb MB (sandbox.pageFileMb)." | Add-Content -LiteralPath $log
} catch {
    "Paging file left as it is: $($_.Exception.Message)" | Add-Content -LiteralPath $log
}
exit 0
