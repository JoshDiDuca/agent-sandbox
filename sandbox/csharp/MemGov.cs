// memgov.exe: the Windows side of the sandbox's memory governor (src/guest/governor). One long-running process the
// daemon talks to over stdin/stdout, so the decisions stay in TypeScript and only the Win32 calls live here. C# 5.
//
//   stdout, a JSON line every --interval seconds (default 2):
//     {"ramTotalMb":..,"ramAvailMb":..,"commitLimitMb":..,"commitAvailMb":..,"procs":[{"pid":..,"name":"rustc","mb":..,"prio":"normal"}]}
//     procs = the processes in the agents' job (the job ptyhost makes for everything the agents start), nothing else.
//   stdin, one command per line:
//     priority <pid> <idle|below|normal>   lowers (or restores) the priority of a process in that job
//     suspend <pid> <ms>                   pauses a process in that job, resumes it after ms (at most 30000)
//     exit
//
// It only ever touches processes that are in the agents' job, never itself, and resumes everything it paused when it
// ends or when the daemon goes away (stdin closes).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class MemGov
{
    private const string AgentJobName = "Local\\AgentSandboxAgentsJob";
    private const double BytesPerMb = 1024.0 * 1024.0;
    private const int MaxProcesses = 1024;
    private const int MaxSuspendMs = 30000;
    private const uint JobObjectQuery = 0x0004;
    private const int JobObjectBasicProcessIdList = 3;
    private const uint ProcessQueryLimited = 0x1000;
    private const uint ProcessSetInformation = 0x0200;
    private const uint ProcessSuspendResume = 0x0800;
    private const uint IdleClass = 0x00000040;
    private const uint BelowNormalClass = 0x00004000;
    private const uint NormalClass = 0x00000020;

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

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetPriorityClass(IntPtr process, uint priorityClass);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint GetPriorityClass(IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("ntdll.dll")]
        public static extern int NtSuspendProcess(IntPtr process);

        [DllImport("ntdll.dll")]
        public static extern int NtResumeProcess(IntPtr process);
    }

    private static readonly object Gate = new object();
    private static readonly Dictionary<int, DateTime> Paused = new Dictionary<int, DateTime>();

    /// <summary>The paused process ids on disk, so a memgov that is killed mid-pause is undone by the next one.</summary>
    private static readonly string HeldFile = Path.Combine(Path.GetTempPath(), "agent-sandbox-memgov-held.txt");
    private static IntPtr job = IntPtr.Zero;
    private static volatile bool stop;

    static int Main(string[] args)
    {
        if (args.Length == 0 || args[0] != "serve")
        {
            Console.Error.WriteLine("usage: memgov serve [--interval seconds]");
            return 2;
        }
        int interval = 2;
        for (int i = 1; i + 1 < args.Length; i++)
        {
            if (args[i] == "--interval")
            {
                int.TryParse(args[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out interval);
            }
        }
        if (interval < 1)
        {
            interval = 2;
        }
        // A memgov that ended without resuming (killed, crashed) left its pauses in the file: undo them first.
        RecoverHeld();
        Thread commands = new Thread(ReadCommands);
        commands.IsBackground = true;
        commands.Start();
        Thread resumer = new Thread(ResumeWhenDue);
        resumer.IsBackground = true;
        resumer.Start();
        while (!stop)
        {
            try
            {
                Console.Out.WriteLine(Sample());
                Console.Out.Flush();
            }
            catch (Exception)
            {
                // A sample that fails (a process ended while it was read) is skipped; the next one tries again.
            }
            for (int waited = 0; waited < interval * 10 && !stop; waited++)
            {
                Thread.Sleep(100);
            }
        }
        ResumeAll();
        return 0;
    }

    /// <summary>The job, opened once it exists (ptyhost makes it when the first agent starts).</summary>
    private static IntPtr Job()
    {
        if (job == IntPtr.Zero)
        {
            job = NativeMethods.OpenJobObjectW(JobObjectQuery, false, AgentJobName);
        }
        return job;
    }

    private static string Sample()
    {
        MemoryStatus status = new MemoryStatus();
        status.Length = (uint)Marshal.SizeOf(typeof(MemoryStatus));
        if (!NativeMethods.GlobalMemoryStatusEx(ref status))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"ramTotalMb\":").Append(Mb(status.TotalPhys));
        sb.Append(",\"ramAvailMb\":").Append(Mb(status.AvailPhys));
        sb.Append(",\"commitLimitMb\":").Append(Mb(status.TotalPageFile));
        sb.Append(",\"commitAvailMb\":").Append(Mb(status.AvailPageFile));
        sb.Append(",\"procs\":[");
        bool first = true;
        int self = Process.GetCurrentProcess().Id;
        foreach (int pid in JobProcessIds())
        {
            if (pid == self)
            {
                continue;
            }
            try
            {
                using (Process p = Process.GetProcessById(pid))
                {
                    if (!first)
                    {
                        sb.Append(',');
                    }
                    first = false;
                    sb.Append("{\"pid\":").Append(pid.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"name\":").Append(Json(p.ProcessName));
                    sb.Append(",\"mb\":").Append(Mb((ulong)p.PrivateMemorySize64));
                    sb.Append(",\"prio\":\"").Append(PriorityName(pid)).Append("\"}");
                }
            }
            catch (Exception)
            {
                // The process ended while it was read.
            }
        }
        return sb.Append("]}").ToString();
    }

    private static List<int> JobProcessIds()
    {
        List<int> ids = new List<int>();
        IntPtr handle = Job();
        if (handle == IntPtr.Zero)
        {
            return ids;
        }
        // JOBOBJECT_BASIC_PROCESS_ID_LIST: two counts, then the ids (pointer-sized).
        int length = 8 + IntPtr.Size * MaxProcesses;
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!NativeMethods.QueryInformationJobObject(handle, JobObjectBasicProcessIdList, buffer, length, IntPtr.Zero))
            {
                return ids;
            }
            int count = Marshal.ReadInt32(buffer, 4);
            for (int i = 0; i < count && i < MaxProcesses; i++)
            {
                ids.Add((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return ids;
    }

    private static string PriorityName(int pid)
    {
        IntPtr process = NativeMethods.OpenProcess(ProcessQueryLimited, false, pid);
        if (process == IntPtr.Zero)
        {
            return "normal";
        }
        try
        {
            uint c = NativeMethods.GetPriorityClass(process);
            return c == IdleClass ? "idle" : c == BelowNormalClass ? "below" : "normal";
        }
        finally
        {
            NativeMethods.CloseHandle(process);
        }
    }

    /// <summary>Whether pid is a process of the agents' job and not this one: the only ones this program touches.</summary>
    private static bool Allowed(int pid)
    {
        return pid != Process.GetCurrentProcess().Id && JobProcessIds().Contains(pid);
    }

    private static void ReadCommands()
    {
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            try
            {
                Run(line.Trim().Split(' '));
            }
            catch (Exception)
            {
                // A bad command is ignored.
            }
            if (stop)
            {
                return;
            }
        }
        // The daemon is gone: put everything back and end.
        stop = true;
    }

    private static void Run(string[] parts)
    {
        if (parts.Length == 1 && parts[0] == "exit")
        {
            stop = true;
            return;
        }
        int pid;
        if (parts.Length < 3 || !int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid) || !Allowed(pid))
        {
            return;
        }
        if (parts[0] == "priority")
        {
            uint cls = parts[2] == "idle" ? IdleClass : parts[2] == "below" ? BelowNormalClass : NormalClass;
            IntPtr process = NativeMethods.OpenProcess(ProcessSetInformation, false, pid);
            if (process != IntPtr.Zero)
            {
                NativeMethods.SetPriorityClass(process, cls);
                NativeMethods.CloseHandle(process);
            }
        }
        else if (parts[0] == "suspend")
        {
            int ms;
            if (!int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out ms) || ms < 1)
            {
                return;
            }
            Suspend(pid, Math.Min(ms, MaxSuspendMs));
        }
    }

    private static void Suspend(int pid, int ms)
    {
        lock (Gate)
        {
            if (Paused.ContainsKey(pid))
            {
                return;
            }
            IntPtr process = NativeMethods.OpenProcess(ProcessSuspendResume, false, pid);
            if (process == IntPtr.Zero)
            {
                return;
            }
            try
            {
                // Recorded before the pause, so a memgov that dies right after still lets the next one resume it.
                Paused[pid] = DateTime.UtcNow.AddMilliseconds(ms);
                SaveHeld();
                NativeMethods.NtSuspendProcess(process);
            }
            finally
            {
                NativeMethods.CloseHandle(process);
            }
        }
    }

    private static void Resume(int pid)
    {
        IntPtr process = NativeMethods.OpenProcess(ProcessSuspendResume, false, pid);
        if (process != IntPtr.Zero)
        {
            NativeMethods.NtResumeProcess(process);
            NativeMethods.CloseHandle(process);
        }
    }

    /// <summary>A paused process always comes back: when its time is up (checked every 100 ms).</summary>
    private static void ResumeWhenDue()
    {
        while (true)
        {
            Thread.Sleep(100);
            lock (Gate)
            {
                List<int> due = new List<int>();
                foreach (KeyValuePair<int, DateTime> p in Paused)
                {
                    if (p.Value <= DateTime.UtcNow)
                    {
                        due.Add(p.Key);
                    }
                }
                foreach (int pid in due)
                {
                    Resume(pid);
                    Paused.Remove(pid);
                }
                if (due.Count > 0)
                {
                    SaveHeld();
                }
            }
        }
    }

    private static void ResumeAll()
    {
        lock (Gate)
        {
            foreach (int pid in new List<int>(Paused.Keys))
            {
                Resume(pid);
            }
            Paused.Clear();
            SaveHeld();
        }
    }

    /// <summary>The processes paused right now, one id per line (empty: the file goes). Called with Gate held.</summary>
    private static void SaveHeld()
    {
        try
        {
            if (Paused.Count == 0)
            {
                File.Delete(HeldFile);
                return;
            }
            List<string> lines = new List<string>();
            foreach (int pid in Paused.Keys)
            {
                lines.Add(pid.ToString(CultureInfo.InvariantCulture));
            }
            File.WriteAllLines(HeldFile, lines.ToArray());
        }
        catch (IOException)
        {
            // Best effort: the in-memory list still resumes every pause while this memgov runs.
        }
        catch (UnauthorizedAccessException)
        {
            // Same as above.
        }
    }

    /// <summary>Resumes what an earlier memgov paused and never resumed. Resuming a running process changes nothing.</summary>
    private static void RecoverHeld()
    {
        try
        {
            if (!File.Exists(HeldFile))
            {
                return;
            }
            foreach (string line in File.ReadAllLines(HeldFile))
            {
                int pid;
                if (int.TryParse(line.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out pid) && pid > 0)
                {
                    Resume(pid);
                }
            }
            File.Delete(HeldFile);
        }
        catch (IOException)
        {
            // Nothing more to do: the file stays and the next start tries again.
        }
        catch (UnauthorizedAccessException)
        {
            // Same as above.
        }
    }

    private static string Mb(ulong bytes)
    {
        return Math.Floor(bytes / BytesPerMb).ToString("0", CultureInfo.InvariantCulture);
    }

    private static string Json(string value)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in value)
        {
            if (c == '"' || c == '\\')
            {
                sb.Append('\\').Append(c);
            }
            else if (c < 0x20)
            {
                sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            }
            else
            {
                sb.Append(c);
            }
        }
        return sb.Append('"').ToString();
    }
}
