// Creates a blank dynamic VHDX with CreateVirtualDisk (virtdisk.dll). The disk is never attached to this PC: no
// AttachVirtualDisk, no mount, no drive letter. Signatures from the Microsoft virtdisk.h reference (not re-checked).
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace AgentSandbox.HcsHost
{
    public static class VirtualDisk
    {
        private const uint VirtualStorageTypeDeviceVhdx = 3;
        private static readonly Guid VendorMicrosoft = new Guid("EC984AEC-A0F9-47e9-901F-71415A66345B");
        private const uint CreateVirtualDiskVersion1 = 1;
        private const uint AccessNone = 0;
        private const uint FlagNone = 0;

        [StructLayout(LayoutKind.Sequential)]
        private struct VirtualStorageType
        {
            public uint DeviceId;
            public Guid VendorId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CreateVirtualDiskParametersV1
        {
            public uint Version;
            public Guid UniqueId;
            public ulong MaximumSize;
            public uint BlockSizeInBytes;
            public uint SectorSizeInBytes;
            public IntPtr ParentPath;
            public IntPtr SourcePath;
        }

        private static class NativeMethods
        {
            [DllImport("virtdisk.dll", CharSet = CharSet.Unicode)]
            public static extern int CreateVirtualDisk(
                ref VirtualStorageType storageType,
                string path,
                uint accessMask,
                IntPtr securityDescriptor,
                uint flags,
                uint providerSpecificFlags,
                ref CreateVirtualDiskParametersV1 parameters,
                IntPtr overlapped,
                out IntPtr handle);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern bool CloseHandle(IntPtr handle);
        }

        /// <summary>A new sparse VHDX of at most maxGb GB. An existing file is never touched.</summary>
        public static void Create(string path, long maxGb)
        {
            if (!path.EndsWith(".vhdx", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException("The disk file must end in .vhdx");
            }
            if (maxGb < 1 || maxGb > 4096)
            {
                throw new ArgumentException("The size must be 1 to 4096 GB");
            }
            if (File.Exists(path))
            {
                throw new IOException("The disk file already exists: " + path);
            }
            VirtualStorageType type = new VirtualStorageType();
            type.DeviceId = VirtualStorageTypeDeviceVhdx;
            type.VendorId = VendorMicrosoft;
            CreateVirtualDiskParametersV1 parameters = new CreateVirtualDiskParametersV1();
            parameters.Version = CreateVirtualDiskVersion1;
            parameters.MaximumSize = (ulong)maxGb * 1024UL * 1024UL * 1024UL;
            IntPtr handle = IntPtr.Zero;
            try
            {
                // CreateVirtualDisk returns the error code itself (not through GetLastError).
                int error = NativeMethods.CreateVirtualDisk(ref type, path, AccessNone, IntPtr.Zero, FlagNone, 0, ref parameters, IntPtr.Zero, out handle);
                if (error != 0)
                {
                    throw new Win32Exception(error);
                }
            }
            finally
            {
                if (handle != IntPtr.Zero && handle != new IntPtr(-1))
                {
                    NativeMethods.CloseHandle(handle);
                }
            }
        }
    }
}
