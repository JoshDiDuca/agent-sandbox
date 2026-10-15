// A folder's own permissions, written WITHOUT walking what is inside it (Set-Acl re-propagates over the whole subtree,
// which takes minutes on a folder with toolchains). Loaded with Add-Type by scripts\set-folder-access.ps1. C# 5.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace AgentSandbox
{
    public static class FolderSecurity
    {
        private const uint DaclSecurityInformation = 0x4;

        private static class NativeMethods
        {
            [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool SetFileSecurityW(string fileName, uint securityInformation, byte[] securityDescriptor);
        }

        /// <summary>Replaces the permissions of this one folder with those in the self-relative descriptor. Children are not touched.</summary>
        public static void SetDacl(string path, byte[] descriptor)
        {
            if (!NativeMethods.SetFileSecurityW(path, DaclSecurityInformation, descriptor))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not set the permissions of " + path);
            }
        }
    }
}
