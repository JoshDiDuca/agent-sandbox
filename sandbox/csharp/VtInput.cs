// Turns on ENABLE_VIRTUAL_TERMINAL_INPUT on another process's console. Loaded by scripts\enable-vt-input.ps1 (Add-Type). C# 5.
using System;
using System.Runtime.InteropServices;

public static class SbxVtInput
{
    private const uint GenericReadWrite = 0xC0000000;
    private const uint ShareReadWrite = 3;
    private const uint OpenExisting = 3;
    private const uint EnableVirtualTerminalInput = 0x200;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool FreeConsole();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AttachConsole(uint pid);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetConsoleMode(IntPtr handle, out uint mode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetConsoleMode(IntPtr handle, uint mode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);
    }

    /// <summary>
    /// Attaches to the console of process pid and adds virtual-terminal input to its input mode. 0 = done, 2 = could
    /// not attach, 3 = no console input, 4 = the mode could not be read or set.
    /// </summary>
    public static int On(uint pid)
    {
        NativeMethods.FreeConsole();
        if (!NativeMethods.AttachConsole(pid))
        {
            return 2;
        }
        IntPtr input = NativeMethods.CreateFileW("CONIN$", GenericReadWrite, ShareReadWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
        if (input == InvalidHandle)
        {
            return 3;
        }
        bool ok;
        try
        {
            uint mode;
            ok = NativeMethods.GetConsoleMode(input, out mode) && NativeMethods.SetConsoleMode(input, mode | EnableVirtualTerminalInput);
        }
        finally
        {
            NativeMethods.CloseHandle(input);
            NativeMethods.FreeConsole();
        }
        return ok ? 0 : 4;
    }
}
