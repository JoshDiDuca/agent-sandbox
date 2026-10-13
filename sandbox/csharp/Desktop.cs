// Applies a wallpaper the way the Settings app does. Loaded by scripts\set-desktop.ps1 (Add-Type). C# 5.
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace AgentSandbox
{
    public static class Desk
    {
        private const int SetDesktopWallpaper = 20;
        private const int UpdateIniFileAndBroadcast = 3;

        private static class NativeMethods
        {
            [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern int SystemParametersInfo(int action, int param, string value, int winIni);
        }

        /// <summary>The raw call (kept for scripts that used it): non-zero on success.</summary>
        public static int SystemParametersInfo(int action, int param, string value, int winIni)
        {
            return NativeMethods.SystemParametersInfo(action, param, value, winIni);
        }

        /// <summary>Shows the image at path as the wallpaper and saves it to the profile. Throws on failure.</summary>
        public static void SetWallpaper(string path)
        {
            if (NativeMethods.SystemParametersInfo(SetDesktopWallpaper, 0, path, UpdateIniFileAndBroadcast) == 0)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
    }
}
