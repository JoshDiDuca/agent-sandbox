// The linker for Rust's GNU host inside the sandbox (CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER). It runs MinGW's gcc,
// but only as many at once as AGENT_LINK_SLOTS allows across the whole sandbox, and with Rust's own lld when
// AGENT_LLD_DIR is set: several agents linking big programs with GNU ld at the same time used 2 GB+ each and took
// Windows down. Each slot is a named mutex, which Windows frees when its owner dies (a killed build never keeps a
// slot). Compiled inside the sandbox with the .NET Framework csc.exe (C# 5).
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

static class LinkGate
{
    private const string SlotPrefix = @"Global\AgentSandboxLinkSlot";

    static int Main()
    {
        string real = Environment.GetEnvironmentVariable("AGENT_REAL_LINKER");
        if (string.IsNullOrEmpty(real) || !File.Exists(real))
        {
            Console.Error.WriteLine("error: the real linker was not found (AGENT_REAL_LINKER).");
            return 1;
        }
        string args = ArgumentsOf(Environment.CommandLine);
        string lld = Environment.GetEnvironmentVariable("AGENT_LLD_DIR");
        if (!string.IsNullOrEmpty(lld) && File.Exists(Path.Combine(lld, "ld.lld.exe")))
        {
            args = args + " -fuse-ld=lld \"-B" + lld + "\"";
        }
        Mutex[] slots = new Mutex[SlotCount()];
        for (int i = 0; i < slots.Length; i++)
        {
            slots[i] = new Mutex(false, SlotPrefix + i);
        }
        try
        {
            int held = Acquire(slots);
            try
            {
                return Run(real, args);
            }
            finally
            {
                slots[held].ReleaseMutex();
            }
        }
        finally
        {
            foreach (Mutex slot in slots)
            {
                slot.Dispose();
            }
        }
    }

    /// <summary>Waits for any free slot and returns its index (a slot left by a killed linker counts as free).</summary>
    static int Acquire(Mutex[] slots)
    {
        try
        {
            return WaitHandle.WaitAny(slots);
        }
        catch (AbandonedMutexException e)
        {
            return e.MutexIndex;
        }
    }

    static int Run(string program, string args)
    {
        ProcessStartInfo start = new ProcessStartInfo(program, args);
        start.UseShellExecute = false;
        // Ctrl+C reaches the linker too (same console); the gate only waits for it to finish.
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; };
        using (Process p = Process.Start(start))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    static int SlotCount()
    {
        int slots;
        string value = Environment.GetEnvironmentVariable("AGENT_LINK_SLOTS");
        return int.TryParse(value, out slots) && slots > 0 && slots <= 32 ? slots : 2;
    }

    // Everything after the program name, untouched, so quoting survives exactly as cargo wrote it.
    static string ArgumentsOf(string commandLine)
    {
        string s = commandLine.TrimStart();
        int end;
        if (s.StartsWith("\""))
        {
            end = s.IndexOf('"', 1);
            end = end < 0 ? s.Length : end + 1;
        }
        else
        {
            end = s.IndexOf(' ');
            if (end < 0)
            {
                end = s.Length;
            }
        }
        return s.Substring(end).TrimStart();
    }
}
