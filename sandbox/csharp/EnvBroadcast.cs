// Tells running programs (Explorer, Windows Terminal) that the machine environment changed, so new windows and tabs
// read the current PATH. Loaded by scripts\set-machine-environment.ps1 (Add-Type). C# 5.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace AgentSandbox
{
    public static class EnvBroadcast
    {
        private static readonly IntPtr HwndBroadcast = new IntPtr(0xffff);
        private const uint WmSettingChange = 0x001A;
        private const uint SmtoAbortIfHung = 0x0002;
        private const uint TimeoutMs = 2000;

        private static class NativeMethods
        {
            [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
        }

        /// <summary>Broadcasts WM_SETTINGCHANGE "Environment". Throws on failure.</summary>
        public static void Notify()
        {
            UIntPtr result;
            IntPtr sent = NativeMethods.SendMessageTimeout(HwndBroadcast, WmSettingChange, UIntPtr.Zero, "Environment", SmtoAbortIfHung, TimeoutMs, out result);
            if (sent == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
    }
}
