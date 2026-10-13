// Keeps this PC from sleeping while a sandbox runs (sandbox.keepAwake): HostTools keep-awake, or Add-Type from
// scripts\keep-awake.ps1 when HostTools cannot be built. C# 5.
using System.Runtime.InteropServices;

namespace AgentSandbox
{
    public static class Power
    {
        // ES_CONTINUOUS | ES_SYSTEM_REQUIRED: the system stays awake until this thread ends or clears it.
        private const uint ContinuousSystemRequired = 0x80000001;

        private static class NativeMethods
        {
            [DllImport("kernel32.dll")]
            public static extern uint SetThreadExecutionState(uint flags);
        }

        /// <summary>Asks Windows not to sleep for as long as the calling thread runs.</summary>
        public static void StayAwake()
        {
            NativeMethods.SetThreadExecutionState(ContinuousSystemRequired);
        }
    }
}
