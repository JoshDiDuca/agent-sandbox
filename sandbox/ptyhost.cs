// ptyhost: runs one console program inside a Windows pseudo console (ConPTY) and shares it with any number of
// TCP clients (the window inside the sandbox and `--terminal` on the host). Compiled inside the sandbox with the
// .NET Framework csc.exe, so it must stay C# 5 (no string interpolation, no ?., no expression-bodied members).
//
// Usage: ptyhost.exe <port> <token> <cols> <rows> <logFile> <commandLine> [<restartCommandLine>]
//
// Wire format, both directions: [type:1][length:4, little endian][payload].
//   client -> host  1 HELLO   [cols:2][rows:2][flags:1][token utf8]   flags bit 0 = control-only (no output, no sizing)
//                   2 INPUT   raw bytes for the program
//                   3 RESIZE  [cols:2][rows:2]
//                   4 RESTART restart the program with <restartCommandLine> (e.g. after switching accounts)
//   host -> client 16 OUTPUT  raw VT output
//                  17 EXIT    [exitCode:4]
//                  18 ERROR   utf8 message
//                  19 RESTARTING
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class PtyHost
{
    const byte Hello = 1, Input = 2, Resize = 3, Restart = 4;
    const byte Output = 16, Exit = 17, Error = 18, Restarting = 19;

    static readonly object Gate = new object();
    static readonly List<Client> Clients = new List<Client>();
    static Session current;
    static Client sizeOwner;
    static short cols, rows;
    static byte[] token;
    static string logFile;
    static string restartCommand;
    static volatile bool restartRequested;

    sealed class Client
    {
        public TcpClient Tcp;
        public NetworkStream Stream;
        public readonly object WriteLock = new object();
        public bool ControlOnly;
        public short Cols, Rows;
    }

    static int Main(string[] args)
    {
        if (args.Length < 6) { Console.Error.WriteLine("usage: ptyhost <port> <token> <cols> <rows> <logFile> <commandLine> [<restartCommandLine>]"); return 2; }
        int port = int.Parse(args[0]);
        token = Encoding.UTF8.GetBytes(args[1]);
        cols = short.Parse(args[2]);
        rows = short.Parse(args[3]);
        logFile = args[4];
        string command = args[5];
        restartCommand = args.Length > 6 && args[6].Length > 0 ? args[6] : command;
        try
        {
            var listener = new TcpListener(IPAddress.Any, port);
            listener.Start();
            new Thread(() => AcceptLoop(listener)) { IsBackground = true }.Start();
            Log("listening on port " + port + ": " + command);
            int exitCode;
            while (true)
            {
                Session session = Session.Start(command, cols, rows);
                lock (Gate) current = session;
                exitCode = session.WaitForExit();
                if (!restartRequested) break;
                restartRequested = false;
                command = restartCommand;
                Log("restarting: " + command);
            }
            Log("program exited with code " + exitCode);
            byte[] code = BitConverter.GetBytes(exitCode);
            foreach (Client c in Snapshot()) { Send(c, Exit, code); Drop(c); }
            return exitCode;
        }
        catch (Exception e)
        {
            Log("FATAL " + e);
            return 1;
        }
    }

    // ---- sessions ---------------------------------------------------------------------------------------------

    sealed class Session
    {
        IntPtr pseudoConsole;
        IntPtr process;
        FileStream input;
        Thread pump;
        bool closed;

        public static Session Start(string commandLine, short width, short height)
        {
            SafeFileHandle inRead, inWrite, outRead, outWrite;
            if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0)) throw new IOException("CreatePipe failed: " + Marshal.GetLastWin32Error());
            if (!CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) throw new IOException("CreatePipe failed: " + Marshal.GetLastWin32Error());
            var s = new Session();
            int hr = CreatePseudoConsole(new Coord { X = width, Y = height }, inRead, outWrite, 0, out s.pseudoConsole);
            if (hr != 0) throw new IOException("CreatePseudoConsole failed: 0x" + hr.ToString("X8"));
            inRead.Dispose();
            outWrite.Dispose();
            s.input = new FileStream(inWrite, FileAccess.Write);
            s.process = Spawn(commandLine, s.pseudoConsole);
            var output = new FileStream(outRead, FileAccess.Read);
            s.pump = new Thread(() => s.Pump(output)) { IsBackground = true };
            s.pump.Start();
            return s;
        }

        void Pump(FileStream output)
        {
            var buffer = new byte[16384];
            try
            {
                int n;
                while ((n = output.Read(buffer, 0, buffer.Length)) > 0)
                {
                    var chunk = new byte[n];
                    Buffer.BlockCopy(buffer, 0, chunk, 0, n);
                    foreach (Client c in Snapshot()) if (!c.ControlOnly) Send(c, Output, chunk);
                }
            }
            catch (IOException) { }
        }

        public int WaitForExit()
        {
            WaitForSingleObject(process, 0xFFFFFFFF);
            uint code;
            GetExitCodeProcess(process, out code);
            Close();
            pump.Join(5000);
            return (int)code;
        }

        public void Write(byte[] data)
        {
            try { lock (input) { input.Write(data, 0, data.Length); input.Flush(); } } catch (IOException) { } catch (ObjectDisposedException) { }
        }

        public void Resize(short width, short height) { lock (this) if (!closed) ResizePseudoConsole(pseudoConsole, new Coord { X = width, Y = height }); }

        // Closing the pseudo console ends every process attached to it (the agent and anything it started).
        public void Kill() { TerminateProcess(process, 1); Close(); }

        void Close()
        {
            lock (this)
            {
                if (closed) return;
                closed = true;
                try { input.Dispose(); } catch (IOException) { }
                ClosePseudoConsole(pseudoConsole);
            }
        }
    }

    static IntPtr Spawn(string commandLine, IntPtr pseudoConsole)
    {
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr attributes = Marshal.AllocHGlobal(size);
        try
        {
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new IOException("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
            if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x00020016, pseudoConsole, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new IOException("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
            var info = new StartupInfoEx();
            info.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            info.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES with null handles: never leak our own stdio into the child
            info.lpAttributeList = attributes;
            ProcessInformation pi;
            const uint ExtendedStartupInfoPresent = 0x00080000;
            if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, ExtendedStartupInfoPresent, IntPtr.Zero, null, ref info, out pi))
                throw new IOException("CreateProcess failed (" + Marshal.GetLastWin32Error() + "): " + commandLine);
            CloseHandle(pi.hThread);
            return pi.hProcess;
        }
        finally
        {
            DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
        }
    }

    // ---- clients ----------------------------------------------------------------------------------------------

    static void AcceptLoop(TcpListener listener)
    {
        while (true)
        {
            TcpClient tcp = listener.AcceptTcpClient();
            tcp.NoDelay = true;
            new Thread(() => Serve(tcp)) { IsBackground = true }.Start();
        }
    }

    static void Serve(TcpClient tcp)
    {
        var c = new Client { Tcp = tcp, Stream = tcp.GetStream() };
        try
        {
            byte type; byte[] payload;
            if (!ReadFrame(c.Stream, out type, out payload) || type != Hello || payload.Length < 5) return;
            byte[] offered = new byte[payload.Length - 5];
            Buffer.BlockCopy(payload, 5, offered, 0, offered.Length);
            if (!TokenMatches(offered)) { Send(c, Error, Encoding.UTF8.GetBytes("access denied")); return; }
            c.Cols = BitConverter.ToInt16(payload, 0);
            c.Rows = BitConverter.ToInt16(payload, 2);
            c.ControlOnly = (payload[4] & 1) != 0;
            lock (Gate) Clients.Add(c);
            if (!c.ControlOnly) TakeOwnership(c);
            while (ReadFrame(c.Stream, out type, out payload))
            {
                Session s;
                lock (Gate) s = current;
                if (type == Input && s != null)
                {
                    if (!c.ControlOnly && sizeOwner != c) TakeOwnership(c);
                    s.Write(payload);
                }
                else if (type == Resize && payload.Length >= 4)
                {
                    c.Cols = BitConverter.ToInt16(payload, 0);
                    c.Rows = BitConverter.ToInt16(payload, 2);
                    if (sizeOwner == c) ApplySize(c.Cols, c.Rows, false);
                }
                else if (type == Restart && s != null)
                {
                    restartRequested = true;
                    foreach (Client other in Snapshot()) if (!other.ControlOnly) Send(other, Restarting, new byte[0]);
                    s.Kill();
                }
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally { Drop(c); }
    }

    // The most recent client to connect or type decides the size (like tmux "latest"). A forced repaint on every
    // ownership change makes ConPTY redraw the whole screen, so a newly attached terminal sees the current state.
    static void TakeOwnership(Client c)
    {
        lock (Gate) sizeOwner = c;
        ApplySize(c.Cols, c.Rows, true);
    }

    static void ApplySize(short width, short height, bool forceRepaint)
    {
        if (width < 2 || height < 2) return;
        Session s;
        lock (Gate) { s = current; cols = width; rows = height; }
        if (s == null) return;
        if (forceRepaint) s.Resize(width, (short)(height - 1));
        s.Resize(width, height);
    }

    static bool TokenMatches(byte[] offered)
    {
        int diff = offered.Length ^ token.Length;
        for (int i = 0; i < offered.Length && i < token.Length; i++) diff |= offered[i] ^ token[i];
        return diff == 0;
    }

    static List<Client> Snapshot() { lock (Gate) return new List<Client>(Clients); }

    static void Drop(Client c)
    {
        lock (Gate) { Clients.Remove(c); if (sizeOwner == c) sizeOwner = null; }
        try { c.Tcp.Close(); } catch (Exception) { }
    }

    static void Send(Client c, byte type, byte[] payload)
    {
        var frame = new byte[5 + payload.Length];
        frame[0] = type;
        BitConverter.GetBytes(payload.Length).CopyTo(frame, 1);
        Buffer.BlockCopy(payload, 0, frame, 5, payload.Length);
        try { lock (c.WriteLock) c.Stream.Write(frame, 0, frame.Length); }
        catch (Exception) { Drop(c); }
    }

    static bool ReadFrame(Stream stream, out byte type, out byte[] payload)
    {
        type = 0; payload = null;
        var header = new byte[5];
        if (!ReadExactly(stream, header)) return false;
        int length = BitConverter.ToInt32(header, 1);
        if (length < 0 || length > 1 << 20) return false;
        type = header[0];
        payload = new byte[length];
        return ReadExactly(stream, payload);
    }

    static bool ReadExactly(Stream stream, byte[] buffer)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int n = stream.Read(buffer, offset, buffer.Length - offset);
            if (n <= 0) return false;
            offset += n;
        }
        return true;
    }

    static void Log(string message)
    {
        try { File.AppendAllText(logFile, DateTime.Now.ToString("s") + " " + message + Environment.NewLine); } catch (Exception) { }
    }

    // ---- Win32 ------------------------------------------------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)] struct Coord { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC);
    [DllImport("kernel32.dll")] static extern int ResizePseudoConsole(IntPtr hPC, Coord size);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle hReadPipe, out SafeFileHandle hWritePipe, IntPtr lpPipeAttributes, int nSize);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref StartupInfoEx lpStartupInfo, out ProcessInformation lpProcessInformation);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr hObject);
}
