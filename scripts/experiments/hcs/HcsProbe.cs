// P0 probe helper: read-only calls into computecore.dll (HcsGetServiceProperties, HcsEnumerateComputeSystems).
// C# 5. Creates no compute system, network or disk. Every call is a query.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace AgentSandbox.Experiments
{
    public static class HcsProbe
    {
        private const uint WaitMs = 15000;

        private static class NativeMethods
        {
            [DllImport("computecore.dll", ExactSpelling = true, SetLastError = true)]
            public static extern IntPtr HcsCreateOperation(IntPtr context, IntPtr callback);

            [DllImport("computecore.dll", ExactSpelling = true)]
            public static extern void HcsCloseOperation(IntPtr operation);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsEnumerateComputeSystems(string query, IntPtr operation);

            [DllImport("computecore.dll", ExactSpelling = true)]
            public static extern int HcsWaitForOperationResult(IntPtr operation, uint timeoutMs, out IntPtr resultDocument);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsGetServiceProperties(string propertyQuery, out IntPtr result);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern IntPtr LocalFree(IntPtr mem);
        }

        /// <summary>Takes a LocalFree-able wide string from HCS, returns it as text (empty when null).</summary>
        private static string TakeString(IntPtr p)
        {
            if (p == IntPtr.Zero)
            {
                return "";
            }
            try
            {
                return Marshal.PtrToStringUni(p);
            }
            finally
            {
                NativeMethods.LocalFree(p);
            }
        }

        /// <summary>Result of a probe call: the HRESULT and the JSON (or error JSON) HCS returned.</summary>
        public sealed class Reply
        {
            public int HResult;
            public string Json = "";

            public string HResultText()
            {
                return "0x" + HResult.ToString("X8");
            }

            public string Message()
            {
                if (HResult == 0)
                {
                    return "ok";
                }
                return new Win32Exception(HResult & 0xFFFF).Message;
            }
        }

        /// <summary>HcsGetServiceProperties with a Service_PropertyQuery JSON (null for the default).</summary>
        public static Reply GetServiceProperties(string queryJson)
        {
            Reply reply = new Reply();
            IntPtr result = IntPtr.Zero;
            reply.HResult = NativeMethods.HcsGetServiceProperties(queryJson, out result);
            reply.Json = TakeString(result);
            return reply;
        }

        /// <summary>HcsEnumerateComputeSystems with a SystemQuery JSON (null for all).</summary>
        public static Reply EnumerateComputeSystems(string queryJson)
        {
            Reply reply = new Reply();
            IntPtr operation = NativeMethods.HcsCreateOperation(IntPtr.Zero, IntPtr.Zero);
            if (operation == IntPtr.Zero)
            {
                reply.HResult = Marshal.GetHRForLastWin32Error();
                return reply;
            }
            int hr;
            try
            {
                hr = NativeMethods.HcsEnumerateComputeSystems(queryJson, operation);
                if (hr != 0)
                {
                    reply.HResult = hr;
                    return reply;
                }
                IntPtr doc = IntPtr.Zero;
                reply.HResult = NativeMethods.HcsWaitForOperationResult(operation, WaitMs, out doc);
                reply.Json = TakeString(doc);
                return reply;
            }
            finally
            {
                NativeMethods.HcsCloseOperation(operation);
            }
        }
    }
}
