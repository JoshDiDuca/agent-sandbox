// openssl.exe stand-in on the sandbox's PATH (tools\shims), running the copy Git for Windows ships in
// <tools>\git\mingw64\bin. A real .exe, so CreateProcess callers (Rust's Command::new("openssl"), Node's spawn) find it,
// which a .cmd would not be; and mingw64\bin itself stays off PATH, where it would shadow the MinGW gcc.
// It finds Git relative to itself (<tools>\shims\openssl.exe -> <tools>\git\...) and sets OPENSSL_CONF for the child
// only when the caller has none. C# 5 (compiled in the sandbox by the .NET Framework csc).
using System;
using System.Diagnostics;
using System.IO;

static class OpenSsl
{
    static int Main()
    {
        string here = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string mingw = Path.GetFullPath(Path.Combine(here, "..\\git\\mingw64"));
        string exe = Path.Combine(mingw, "bin\\openssl.exe");
        if (!File.Exists(exe))
        {
            Console.Error.WriteLine("openssl is not available: Git for Windows is not installed in this sandbox.");
            return 127;
        }
        ProcessStartInfo start = new ProcessStartInfo(exe, ArgumentsOf(Environment.CommandLine));
        start.UseShellExecute = false;
        string conf = Path.Combine(mingw, "etc\\ssl\\openssl.cnf");
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("OPENSSL_CONF")) && File.Exists(conf))
        {
            start.EnvironmentVariables["OPENSSL_CONF"] = conf;
        }
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
