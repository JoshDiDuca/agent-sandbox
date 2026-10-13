// cargo.exe stand-in for toolchains.rust.targetDir = "separate": every checkout builds into ITS OWN target\sandbox.
// One CARGO_TARGET_DIR for the whole sandbox made agents working in different git worktrees overwrite each other's
// builds (and the Claude Code Bash tool does not keep a per-call variable). The checkout is the nearest folder with a
// .git (a folder, or the file a worktree has); without one, the nearest folder with a Cargo.toml. A CARGO_TARGET_DIR
// you set yourself always wins. Compiled inside the sandbox with the .NET Framework csc.exe (C# 5).
using System;
using System.Diagnostics;
using System.IO;

static class CargoShim
{
    static int Main()
    {
        string real = Environment.GetEnvironmentVariable("AGENT_REAL_CARGO");
        if (string.IsNullOrEmpty(real) || !File.Exists(real))
        {
            Console.Error.WriteLine("error: the real cargo was not found (AGENT_REAL_CARGO).");
            return 101;
        }
        var start = new ProcessStartInfo(real, ArgumentsOf(Environment.CommandLine)) { UseShellExecute = false };
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("CARGO_TARGET_DIR")))
        {
            string root = CheckoutOf(Environment.CurrentDirectory);
            if (root != null) start.EnvironmentVariables["CARGO_TARGET_DIR"] = Path.Combine(root, "target", "sandbox");
        }
        // Ctrl+C reaches cargo too (same console); the shim only waits for it to finish.
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; };
        using (Process p = Process.Start(start))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    static string CheckoutOf(string dir)
    {
        string cargoRoot = null;
        for (var d = new DirectoryInfo(dir); d != null; d = d.Parent)
        {
            string git = Path.Combine(d.FullName, ".git");
            if (Directory.Exists(git) || File.Exists(git)) return d.FullName;
            if (cargoRoot == null && File.Exists(Path.Combine(d.FullName, "Cargo.toml"))) cargoRoot = d.FullName;
        }
        return cargoRoot;
    }

    // Everything after the program name, untouched, so quoting survives exactly as the caller wrote it.
    static string ArgumentsOf(string commandLine)
    {
        string s = commandLine.TrimStart();
        int end;
        if (s.StartsWith("\"")) { end = s.IndexOf('"', 1); end = end < 0 ? s.Length : end + 1; }
        else { end = s.IndexOf(' '); if (end < 0) end = s.Length; }
        return s.Substring(end).TrimStart();
    }
}
