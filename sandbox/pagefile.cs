// Sets the size of the sandbox's paging file at once, with no restart. Loaded by pagefile.ps1 (Add-Type). C# 5.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SandboxPageFile {
    // UNICODE_STRING. The marshaller copies Buffer to native memory for the length of the call.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NtString { public ushort Length; public ushort MaximumLength; public string Buffer; }

    [DllImport("ntdll.dll")] private static extern int RtlAdjustPrivilege(int privilege, bool enable, bool currentThread, out bool wasEnabled);
    [DllImport("ntdll.dll")] private static extern int NtCreatePagingFile(ref NtString path, ref long minimumBytes, ref long maximumBytes, uint priority);
    [DllImport("ntdll.dll")] private static extern int RtlNtStatusToDosError(int status);

    private const int SeCreatePagefilePrivilege = 15;

    /// <summary>Makes C:\pagefile.sys sizeMb, fixed (it never grows). Throws with Windows' reason on failure.</summary>
    public static void Set(int sizeMb) {
        bool wasEnabled;
        Check(RtlAdjustPrivilege(SeCreatePagefilePrivilege, true, false, out wasEnabled));
        // The same call Windows makes at startup; for the existing file it changes the size in place.
        const string path = @"\??\C:\pagefile.sys";
        NtString name = new NtString { Length = (ushort)(path.Length * 2), MaximumLength = (ushort)(path.Length * 2 + 2), Buffer = path };
        long minimum = sizeMb * 1048576L, maximum = minimum;
        Check(NtCreatePagingFile(ref name, ref minimum, ref maximum, 0));
    }

    private static void Check(int status) {
        if (status != 0) throw new Win32Exception(RtlNtStatusToDosError(status));
    }
}
