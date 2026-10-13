// git.exe stand-in for provisioning.git.access = readonly | none. Programs that look up "git" on PATH (Claude Code,
// Node, shells) find this first; it forwards the exact command line to gitguard.js, which allows or refuses the call.
// Compiled inside the sandbox with the .NET Framework csc.exe (C# 5).
using System;
using System.Diagnostics;

static class GitShim
{
    static int Main()
    {
        string node = Environment.GetEnvironmentVariable("AGENT_GUARD_NODE");
        string guard = Environment.GetEnvironmentVariable("AGENT_GUARD_SCRIPT");
        if (string.IsNullOrEmpty(node) || string.IsNullOrEmpty(guard))
        {
            Console.Error.WriteLine("fatal: git is not available in this sandbox.");
            return 128;
        }
        ProcessStartInfo start = new ProcessStartInfo(node, "\"" + guard + "\" " + ArgumentsOf(Environment.CommandLine));
        start.UseShellExecute = false;
        using (Process p = Process.Start(start))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    // Everything after the program name, untouched, so quoting survives exactly as the caller wrote it.
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
