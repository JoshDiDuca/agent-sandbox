// SandboxTools memory-log: the sandbox's memory state in C:\AgentData\logs\memory-<time>.log while it runs, every 30
// seconds and every 5 when RAM or commit is above 60%, so a crash of Windows inside it leaves the last lines; and
// memory-pressure.txt (ok, high, critical) for agents to check before big builds. Bounded: 1 MB per file, newest 10.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class MemoryLog
{
    public const string DefaultFolder = @"C:\AgentData\logs";
    private const string Header = "time     | RAM used/total MB | commit used/limit MB | biggest processes (private MB)";
    private const long MaxFileBytes = 1024 * 1024;
    private const int KeepFiles = 10;
    private const int Biggest = 5;
    private const int CalmSeconds = 30;
    private const int BusySeconds = 5;
    private const double HighShare = 0.6;
    private const double CriticalShare = 0.85;
    private const double BytesPerMb = 1024.0 * 1024.0;

    // MEMORYSTATUSEX.
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
    }

    /// <summary>Samples until the sandbox shuts down (once: one sample, then returns). Never throws out of a sample.</summary>
    public static void Run(string folder, bool once)
    {
        Directory.CreateDirectory(folder);
        string log = NewLog(folder);
        while (true)
        {
            string level = "ok";
            try
            {
                level = Sample(folder, log);
                if (new FileInfo(log).Length >= MaxFileBytes)
                {
                    log = NewLog(folder);
                }
            }
            catch (Exception)
            {
                // A sample that fails (a file briefly locked) is skipped; the next one tries again.
            }
            if (once)
            {
                return;
            }
            Thread.Sleep(TimeSpan.FromSeconds(level == "ok" ? CalmSeconds : BusySeconds));
        }
    }

    /// <summary>ok, high or critical: the larger of the RAM and commit shares in use.</summary>
    public static string Level(double ramUsed, double ramTotal, double commitUsed, double commitLimit)
    {
        double share = Math.Max(ramUsed / Math.Max(ramTotal, 1), commitUsed / Math.Max(commitLimit, 1));
        return share >= CriticalShare ? "critical" : share >= HighShare ? "high" : "ok";
    }

    /// <summary>One line in the log and the pressure file; returns the level.</summary>
    private static string Sample(string folder, string log)
    {
        MemoryStatus status = new MemoryStatus();
        status.Length = (uint)Marshal.SizeOf(typeof(MemoryStatus));
        if (!NativeMethods.GlobalMemoryStatusEx(ref status))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        double ramTotal = Math.Round(status.TotalPhys / BytesPerMb);
        double ramUsed = ramTotal - Math.Round(status.AvailPhys / BytesPerMb);
        double commitLimit = Math.Round(status.TotalPageFile / BytesPerMb);
        double commitUsed = commitLimit - Math.Round(status.AvailPageFile / BytesPerMb);
        Process[] processes = Process.GetProcesses();
        DateTime now = DateTime.Now;
        string line = string.Format(
            CultureInfo.InvariantCulture,
            "{0:HH:mm:ss} | {1}/{2} | {3}/{4} | {5} processes; {6}",
            now, ramUsed, ramTotal, commitUsed, commitLimit, processes.Length, BiggestProcesses(processes));
        File.AppendAllText(log, line + "\r\n", Encoding.Default);
        string level = Level(ramUsed, ramTotal, commitUsed, commitLimit);
        string pressure = string.Format(
            CultureInfo.InvariantCulture,
            "{0} {1:yyyy-MM-ddTHH:mm:ss} RAM {2}/{3} MB, commit {4}/{5} MB",
            level, now, ramUsed, ramTotal, commitUsed, commitLimit);
        File.WriteAllText(Path.Combine(folder, "memory-pressure.txt"), pressure + "\r\n", Encoding.Default);
        return level;
    }

    /// <summary>"node 812, rustc 640, ...": the five processes with the most private memory, in MB.</summary>
    private static string BiggestProcesses(IEnumerable<Process> processes)
    {
        List<KeyValuePair<string, long>> sizes = new List<KeyValuePair<string, long>>();
        foreach (Process p in processes)
        {
            try
            {
                sizes.Add(new KeyValuePair<string, long>(p.ProcessName, p.PrivateMemorySize64));
            }
            catch (Exception)
            {
                // The process ended while it was being read.
            }
        }
        return string.Join(
            ", ",
            sizes.OrderByDescending(s => s.Value)
                .Take(Biggest)
                .Select(s => s.Key + " " + Math.Round(s.Value / BytesPerMb).ToString(CultureInfo.InvariantCulture)));
    }

    /// <summary>A new log file with its header; the oldest ones beyond the newest 10 are removed. Returns its path.</summary>
    private static string NewLog(string folder)
    {
        string path = Path.Combine(folder, "memory-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + ".log");
        File.WriteAllText(path, Header + "\r\n", Encoding.Default);
        IEnumerable<FileInfo> old = new DirectoryInfo(folder)
            .GetFiles("memory-*.log")
            .OrderByDescending(f => f.LastWriteTime)
            .Skip(KeepFiles);
        foreach (FileInfo file in old)
        {
            try
            {
                file.Delete();
            }
            catch (IOException)
            {
                // In use or gone: the next rotation tries again.
            }
        }
        return path;
    }
}
