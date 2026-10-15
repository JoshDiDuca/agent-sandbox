// Prints the PATH a new shell should have: the machine and user PATH from the registry (variables expanded, no
// duplicates), then anything only this process has. Shell start-up files (PowerShell profile, cmd AutoRun, Git Bash
// profile.d) call it so every new shell sees tools added after its parent started. Built per boot by csc. C# 5.
// Usage: pathsync [--machine <path> --user <path> --process <path>] (the options replace the registry/environment
// values, for tests).
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Microsoft.Win32;

namespace AgentSandbox
{
    public static class PathSync
    {
        private const string MachineKey = @"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";
        private const string UserKey = "Environment";

        public static int Main(string[] args)
        {
            string machine = null;
            string user = null;
            string process = null;
            for (int i = 0; i + 1 < args.Length; i += 2)
            {
                if (args[i] == "--machine") { machine = args[i + 1]; }
                else if (args[i] == "--user") { user = args[i + 1]; }
                else if (args[i] == "--process") { process = args[i + 1]; }
            }
            if (machine == null) { machine = ReadRegistry(Registry.LocalMachine, MachineKey); }
            if (user == null) { user = ReadRegistry(Registry.CurrentUser, UserKey); }
            if (process == null) { process = Environment.GetEnvironmentVariable("PATH") ?? ""; }

            List<string> result = new List<string>();
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            // Entries only this process has come first: a parent put them there on purpose (a virtual environment).
            HashSet<string> registry = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string folder in Split(machine + ";" + user)) { registry.Add(Key(folder)); }
            string runnerNode = RunnerNode();
            foreach (string folder in Split(process))
            {
                if (registry.Contains(Key(folder)) || Key(folder) == runnerNode) { continue; }
                Add(result, seen, folder);
            }
            foreach (string folder in Split(machine)) { Add(result, seen, folder); }
            foreach (string folder in Split(user)) { Add(result, seen, folder); }
            Console.Out.Write(string.Join(";", result.ToArray()));
            return 0;
        }

        private static string ReadRegistry(RegistryKey root, string subKey)
        {
            using (RegistryKey key = root.OpenSubKey(subKey))
            {
                if (key == null) { return ""; }
                object value = key.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames);
                return value == null ? "" : value.ToString();
            }
        }

        /// <summary>The runner's own Node (AGENT_TOOLS\node) is not meant for shells: nvm's node is.</summary>
        private static string RunnerNode()
        {
            string tools = Environment.GetEnvironmentVariable("AGENT_TOOLS");
            return string.IsNullOrEmpty(tools) ? "" : Key(Path.Combine(tools, "node"));
        }

        private static IEnumerable<string> Split(string path)
        {
            foreach (string part in Environment.ExpandEnvironmentVariables(path).Split(';'))
            {
                string folder = part.Trim().Trim('"');
                if (folder.Length > 0) { yield return folder; }
            }
        }

        private static string Key(string folder)
        {
            const char Slash = (char)92;
            string key = folder.Replace('/', Slash);
            if (key.Length > 3) { key = key.TrimEnd(Slash); }
            return key.ToLowerInvariant();
        }

        private static void Add(List<string> result, HashSet<string> seen, string folder)
        {
            if (seen.Add(Key(folder))) { result.Add(folder); }
        }
    }
}
