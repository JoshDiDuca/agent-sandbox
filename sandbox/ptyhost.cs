// ptyhost: runs one console program inside a Windows pseudo console (ConPTY) and shares it with any number of TCP
// clients (the terminal tab inside the sandbox and `--terminal` on the host). Compiled inside the sandbox with the
// .NET Framework csc.exe, so this is C# 5 (no string interpolation, no ?., no expression-bodied members).
//
// Usage: ptyhost.exe <port> <token> <cols> <rows> <logFile> <commandLine> [<restartCommandLine>]
//
// Wire format, both directions: [type:1][length:4, little endian][payload]
//   client -> host  1 HELLO   [cols:2][rows:2][flags:1][token utf8]   flags bit 0 = control-only (no output, no sizing)
//                   2 INPUT   bytes for the program
//                   3 RESIZE  [cols:2][rows:2]
//                   4 RESTART restart the program with <restartCommandLine> (e.g. after switching accounts)
//   host -> client 16 OUTPUT  VT output
//                  17 EXIT    [exitCode:4]
//                  18 ERROR   utf8 message
//                  19 RESTARTING
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class Program
{
    static int Main(string[] args)
    {
        if (args.Length < 6)
        {
            Console.Error.WriteLine("usage: ptyhost <port> <token> <cols> <rows> <logFile> <commandLine> [<restartCommandLine>]");
            return 2;
        }
        var log = new Log(args[4]);
        try
        {
            var hub = new ClientHub(Encoding.UTF8.GetBytes(args[1]), short.Parse(args[2]), short.Parse(args[3]));
            var host = new SessionHost(hub, log, args[5], args.Length > 6 && args[6].Length > 0 ? args[6] : args[5]);
            new Listener(int.Parse(args[0]), hub, host, log).Start();
            return host.Run();
        }
        catch (Exception e)
        {
            log.Write("FATAL " + e);
            return 1;
        }
    }
}

/** Runs the program (and restarts it on request) until it exits on its own. */
sealed class SessionHost
{
    readonly ClientHub hub;
    readonly Log log;
    readonly string restartCommand;
    string command;
    volatile bool restartRequested;

    public SessionHost(ClientHub hub, Log log, string command, string restartCommand)
    {
        this.hub = hub; this.log = log; this.command = command; this.restartCommand = restartCommand;
    }

    public int Run()
    {
        log.Write("starting: " + command);
        while (true)
        {
            using (var console = PseudoConsole.Start(command, hub.Cols, hub.Rows, hub.Broadcast))
            {
                hub.Attach(console);
                int exitCode = console.WaitForExit();
                if (!restartRequested)
                {
                    log.Write("program exited with code " + exitCode + ". Last output:" + Environment.NewLine + hub.TailText());
                    hub.Exit(exitCode);
                    return exitCode;
                }
            }
            restartRequested = false;
            command = restartCommand;
            log.Write("restarting: " + command);
        }
    }

    public void Restart()
    {
        restartRequested = true;
        hub.Notify(Frame.Restarting);
        hub.KillProgram();
    }
}

/** Accepts TCP clients and turns their frames into actions. */
sealed class Listener
{
    readonly int port;
    readonly ClientHub hub;
    readonly SessionHost host;
    readonly Log log;
    const int MaxConnections = 32;
    int connections;

    public Listener(int port, ClientHub hub, SessionHost host, Log log)
    {
        this.port = port; this.hub = hub; this.host = host; this.log = log;
    }

    public void Start()
    {
        // Reachable from the host only when attach is enabled; otherwise just from inside the sandbox.
        bool remote = Environment.GetEnvironmentVariable("PTYHOST_BIND") == "any";
        var listener = new TcpListener(remote ? IPAddress.Any : IPAddress.Loopback, port);
        listener.Start();
        log.Write("listening on " + (remote ? "all addresses" : "loopback") + ", port " + port);
        Background(delegate
        {
            while (true)
            {
                TcpClient tcp = listener.AcceptTcpClient();
                if (Interlocked.Increment(ref connections) > MaxConnections) { Interlocked.Decrement(ref connections); tcp.Close(); continue; }
                tcp.NoDelay = true;
                Background(delegate { try { Serve(tcp); } finally { Interlocked.Decrement(ref connections); } });
            }
        });
    }

    void Serve(TcpClient tcp)
    {
        var client = new Client(tcp);
        try
        {
            byte type; byte[] payload;
            // The handshake must arrive quickly; idle unauthenticated connections are not kept.
            tcp.ReceiveTimeout = 10000;
            if (!Frame.Read(client.Stream, out type, out payload) || type != Frame.Hello || payload.Length < 5) return;
            if (!hub.Admit(client, payload)) return;
            tcp.ReceiveTimeout = 0;
            while (Frame.Read(client.Stream, out type, out payload))
            {
                if (type == Frame.Input) hub.Input(client, payload);
                else if (type == Frame.Resize && payload.Length >= 4) hub.Resize(client, BitConverter.ToInt16(payload, 0), BitConverter.ToInt16(payload, 2));
                else if (type == Frame.Restart) host.Restart();
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally { hub.Kill(client); }
    }

    static void Background(ThreadStart work) { new Thread(work) { IsBackground = true }.Start(); }
}

/** One connection. Frames go through a bounded outbox written by its own thread, so a slow viewer never blocks the agent. */
sealed class Client
{
    public readonly TcpClient Tcp;
    public readonly NetworkStream Stream;
    public readonly BlockingCollection<byte[]> Outbox = new BlockingCollection<byte[]>(4096);
    public bool ControlOnly;
    public short Cols, Rows;

    public Client(TcpClient tcp)
    {
        Tcp = tcp;
        Stream = tcp.GetStream();
        new Thread(Write) { IsBackground = true }.Start();
    }

    void Write()
    {
        try { foreach (byte[] frame in Outbox.GetConsumingEnumerable()) Stream.Write(frame, 0, frame.Length); }
        catch (Exception) { }
        finally { try { Tcp.Close(); } catch (Exception) { } }
    }
}

/**
 * Everyone connected to the session. Output goes to all of them; the most recent client to connect or type decides
 * the size (like tmux "latest"), and every change of owner forces a full repaint so a new viewer sees the screen.
 */
sealed class ClientHub
{
    readonly object gate = new object();
    readonly List<Client> clients = new List<Client>();
    readonly byte[] token;
    readonly byte[] tail = new byte[8192];
    int tailLength;
    PseudoConsole console;
    Client sizeOwner;
    short cols, rows;

    public ClientHub(byte[] token, short cols, short rows) { this.token = token; this.cols = cols; this.rows = rows; }

    public short Cols { get { lock (gate) return cols; } }
    public short Rows { get { lock (gate) return rows; } }

    public void Attach(PseudoConsole next) { lock (gate) console = next; }

    public bool Admit(Client client, byte[] hello)
    {
        var offered = new byte[hello.Length - 5];
        Buffer.BlockCopy(hello, 5, offered, 0, offered.Length);
        if (!TokenMatches(offered))
        {
            Send(client, Frame.Error, Encoding.UTF8.GetBytes("access denied"));
            Retire(client);
            return false;
        }
        client.Cols = BitConverter.ToInt16(hello, 0);
        client.Rows = BitConverter.ToInt16(hello, 2);
        client.ControlOnly = (hello[4] & 1) != 0;
        lock (gate) clients.Add(client);
        if (!client.ControlOnly) TakeOwnership(client);
        return true;
    }

    public void Input(Client client, byte[] data)
    {
        if (client.ControlOnly) return;
        if (sizeOwner != client) TakeOwnership(client);
        PseudoConsole current;
        lock (gate) current = console;
        if (current != null) current.Write(data);
    }

    public void Resize(Client client, short width, short height)
    {
        client.Cols = width; client.Rows = height;
        if (sizeOwner == client) Apply(width, height, false);
    }

    public void Broadcast(byte[] output)
    {
        Remember(output);
        foreach (Client c in Snapshot()) if (!c.ControlOnly) Send(c, Frame.Output, output);
    }

    /** The program's last output as plain text (escape sequences removed), for the log when it exits. */
    public string TailText()
    {
        string text;
        lock (tail) text = Encoding.UTF8.GetString(tail, 0, tailLength);
        text = Regex.Replace(text, "\x1b(\\[[0-9;?]*[ -/]*[@-~]|\\][^\x07\x1b]*(\x07|\x1b\\\\)|[@-Z\\\\-_])", "");
        return Regex.Replace(text, "[\\x00-\\x08\\x0b-\\x1f]", "").Trim();
    }

    void Remember(byte[] output)
    {
        lock (tail)
        {
            int keep = Math.Min(tailLength, tail.Length - Math.Min(output.Length, tail.Length));
            Buffer.BlockCopy(tail, tailLength - keep, tail, 0, keep);
            int add = Math.Min(output.Length, tail.Length);
            Buffer.BlockCopy(output, output.Length - add, tail, keep, add);
            tailLength = keep + add;
        }
    }

    public void Notify(byte type)
    {
        foreach (Client c in Snapshot()) if (!c.ControlOnly) Send(c, type, new byte[0]);
    }

    public void KillProgram()
    {
        PseudoConsole current;
        lock (gate) current = console;
        if (current != null) current.Kill();
    }

    public void Exit(int exitCode)
    {
        byte[] code = BitConverter.GetBytes(exitCode);
        var everyone = Snapshot();
        foreach (Client c in everyone) { Send(c, Frame.Exit, code); Retire(c); }
        // Give the writer threads a moment to deliver the EXIT frame before the process ends.
        foreach (Client c in everyone) for (int i = 0; i < 20 && c.Outbox.Count > 0; i++) Thread.Sleep(50);
    }

    /** Stops sending to a client after what is already queued (its writer closes the connection when done). */
    public void Retire(Client client)
    {
        lock (gate) { clients.Remove(client); if (sizeOwner == client) sizeOwner = null; }
        try { client.Outbox.CompleteAdding(); } catch (ObjectDisposedException) { }
    }

    /** Disconnects a client (after at most half a second for frames already queued, e.g. "access denied"). */
    public void Kill(Client client)
    {
        Retire(client);
        for (int i = 0; i < 20 && client.Outbox.Count > 0; i++) Thread.Sleep(25);
        try { client.Tcp.Close(); } catch (Exception) { }
    }

    void TakeOwnership(Client client)
    {
        lock (gate) sizeOwner = client;
        Apply(client.Cols, client.Rows, true);
    }

    void Apply(short width, short height, bool forceRepaint)
    {
        if (width < 2 || height < 2) return;
        PseudoConsole current;
        lock (gate) { current = console; cols = width; rows = height; }
        if (current == null) return;
        // ConPTY repaints everything on a size change; resizing by one row first forces that even for the same size.
        if (forceRepaint) current.Resize(width, (short)(height - 1));
        current.Resize(width, height);
    }

    bool TokenMatches(byte[] offered)
    {
        int diff = offered.Length ^ token.Length;
        for (int i = 0; i < offered.Length && i < token.Length; i++) diff |= offered[i] ^ token[i];
        return diff == 0;
    }

    List<Client> Snapshot() { lock (gate) return new List<Client>(clients); }

    /** Queues a frame; a client whose outbox is full has stopped reading and is disconnected. */
    void Send(Client client, byte type, byte[] payload)
    {
        bool queued;
        try { queued = client.Outbox.TryAdd(Frame.Encode(type, payload)); }
        catch (InvalidOperationException) { return; }
        if (!queued) Kill(client);
    }
}

/** One program running inside a pseudo console, with a thread pumping its output to `onOutput`. */
sealed class PseudoConsole : IDisposable
{
    readonly IntPtr handle;
    readonly IntPtr process;
    readonly FileStream input;
    readonly Thread pump;
    readonly object gate = new object();
    bool closed, disposed;

    PseudoConsole(IntPtr handle, IntPtr process, FileStream input, Thread pump)
    {
        this.handle = handle; this.process = process; this.input = input; this.pump = pump;
    }

    public static PseudoConsole Start(string commandLine, short cols, short rows, Action<byte[]> onOutput)
    {
        SafeFileHandle inRead, inWrite, outRead, outWrite;
        Native.Check(Native.CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0), "CreatePipe");
        Native.Check(Native.CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0), "CreatePipe");
        IntPtr handle;
        int hr = Native.CreatePseudoConsole(new Native.Coord { X = cols, Y = rows }, inRead, outWrite, 0, out handle);
        if (hr != 0) throw new IOException("CreatePseudoConsole failed: 0x" + hr.ToString("X8"));
        inRead.Dispose();
        outWrite.Dispose();
        IntPtr process = Native.Spawn(commandLine, handle);
        var output = new FileStream(outRead, FileAccess.Read);
        var pump = new Thread(() => Pump(output, onOutput)) { IsBackground = true };
        pump.Start();
        return new PseudoConsole(handle, process, new FileStream(inWrite, FileAccess.Write), pump);
    }

    static void Pump(FileStream output, Action<byte[]> onOutput)
    {
        var buffer = new byte[16384];
        try
        {
            int n;
            while ((n = output.Read(buffer, 0, buffer.Length)) > 0)
            {
                var chunk = new byte[n];
                Buffer.BlockCopy(buffer, 0, chunk, 0, n);
                onOutput(chunk);
            }
        }
        catch (IOException) { }
        finally { output.Dispose(); }
    }

    public int WaitForExit()
    {
        Native.WaitForSingleObject(process, 0xFFFFFFFF);
        uint code;
        Native.GetExitCodeProcess(process, out code);
        Close();
        pump.Join(5000);
        return (int)code;
    }

    public void Write(byte[] data)
    {
        try { lock (input) { input.Write(data, 0, data.Length); input.Flush(); } }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
    }

    public void Resize(short cols, short rows)
    {
        lock (gate) if (!closed) Native.ResizePseudoConsole(handle, new Native.Coord { X = cols, Y = rows });
    }

    /** Closing the pseudo console ends every process attached to it (the agent and anything it started). */
    public void Kill()
    {
        lock (gate) { if (disposed) return; Native.TerminateProcess(process, 1); }
        Close();
    }

    public void Dispose()
    {
        Close();
        lock (gate) { if (disposed) return; disposed = true; Native.CloseHandle(process); }
    }

    void Close()
    {
        lock (gate)
        {
            if (closed) return;
            closed = true;
            try { input.Dispose(); } catch (IOException) { }
            Native.ClosePseudoConsole(handle);
        }
    }
}

/** The wire format (see the top of this file). */
static class Frame
{
    public const byte Hello = 1, Input = 2, Resize = 3, Restart = 4;
    public const byte Output = 16, Exit = 17, Error = 18, Restarting = 19;
    const int MaxPayload = 1 << 20;

    public static bool Read(Stream stream, out byte type, out byte[] payload)
    {
        type = 0; payload = null;
        var header = new byte[5];
        if (!ReadExactly(stream, header)) return false;
        int length = BitConverter.ToInt32(header, 1);
        if (length < 0 || length > MaxPayload) return false;
        type = header[0];
        payload = new byte[length];
        return ReadExactly(stream, payload);
    }

    public static byte[] Encode(byte type, byte[] payload)
    {
        var frame = new byte[5 + payload.Length];
        frame[0] = type;
        BitConverter.GetBytes(payload.Length).CopyTo(frame, 1);
        Buffer.BlockCopy(payload, 0, frame, 5, payload.Length);
        return frame;
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
}

sealed class Log
{
    readonly string file;
    public Log(string file) { this.file = file; }
    public void Write(string message)
    {
        try { File.AppendAllText(file, DateTime.Now.ToString("s") + " " + message + Environment.NewLine); } catch (Exception) { }
    }
}

static class Native
{
    [StructLayout(LayoutKind.Sequential)] public struct Coord { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    const uint ExtendedStartupInfoPresent = 0x00080000;
    const int UseStdHandles = 0x00000100;
    static readonly IntPtr PseudoConsoleAttribute = (IntPtr)0x00020016;

    public static void Check(bool ok, string what) { if (!ok) throw new IOException(what + " failed: " + Marshal.GetLastWin32Error()); }

    /** Starts `commandLine` attached to the pseudo console. Null std handles: never leak our own stdio into the child. */
    public static IntPtr Spawn(string commandLine, IntPtr pseudoConsole)
    {
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr attributes = Marshal.AllocHGlobal(size);
        try
        {
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "InitializeProcThreadAttributeList");
            Check(UpdateProcThreadAttribute(attributes, 0, PseudoConsoleAttribute, pseudoConsole, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute");
            var info = new StartupInfoEx();
            info.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            info.StartupInfo.dwFlags = UseStdHandles;
            info.lpAttributeList = attributes;
            ProcessInformation pi;
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

    [DllImport("kernel32.dll")] public static extern int CreatePseudoConsole(Coord size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC);
    [DllImport("kernel32.dll")] public static extern int ResizePseudoConsole(IntPtr hPC, Coord size);
    [DllImport("kernel32.dll")] public static extern void ClosePseudoConsole(IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CreatePipe(out SafeFileHandle hReadPipe, out SafeFileHandle hWritePipe, IntPtr lpPipeAttributes, int nSize);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref StartupInfoEx lpStartupInfo, out ProcessInformation lpProcessInformation);
    [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr hObject);
}
