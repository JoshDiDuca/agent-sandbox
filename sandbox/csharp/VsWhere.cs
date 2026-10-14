// vswhere stand-in for the sandbox's portable MSVC (no Visual Studio installer exists in Windows Sandbox). Build tools,
// CMake, node-gyp and project scripts ask vswhere where Visual Studio is; this answers with the portable tree, laid out
// like a Build Tools install (<root>\VC\Tools\MSVC\<ver>, <root>\VC\Auxiliary\Build\vcvars64.bat).
// It reads vswhere.json next to itself: {"installationPath": "...", "installationVersion": "17.x.y.z"}.
// C# 5 (compiled in the sandbox by the .NET Framework csc). Filters (-latest, -products, -requires, -version) are
// accepted and ignored: there is exactly one instance, and it has the C++ tools.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

static class VsWhere
{
    private const int MaxFindResults = 100;

    static int Main(string[] args)
    {
        string here = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string config = Path.Combine(here, "vswhere.json");
        if (!File.Exists(config))
        {
            // No instance: print nothing, like vswhere without Visual Studio.
            return 0;
        }
        string json = File.ReadAllText(config);
        Dictionary<string, string> instance = new Dictionary<string, string>();
        instance["instanceId"] = "agentsandbox";
        instance["installationName"] = "VisualStudio/portable";
        instance["installationPath"] = Read(json, "installationPath");
        instance["installationVersion"] = Read(json, "installationVersion");
        instance["productId"] = "Microsoft.VisualStudio.Product.BuildTools";
        instance["productPath"] = instance["installationPath"];
        instance["displayName"] = "Visual Studio Build Tools 2022 (portable, Windows Development Sandbox)";
        instance["isComplete"] = "true";
        instance["isLaunchable"] = "true";

        string property = null;
        string find = null;
        string format = "text";
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i].TrimStart('-', '/').ToLowerInvariant();
            string next = i + 1 < args.Length ? args[i + 1] : null;
            if (next == null)
            {
                continue;
            }
            if (a == "property")
            {
                property = next;
                i++;
            }
            else if (a == "find")
            {
                find = next;
                i++;
            }
            else if (a == "format")
            {
                format = next.ToLowerInvariant();
                i++;
            }
            else if (a == "products" || a == "requires" || a == "version" || a == "requiresany")
            {
                i++;
                while (i + 1 < args.Length && !args[i + 1].StartsWith("-"))
                {
                    i++;
                }
            }
        }
        if (find != null)
        {
            foreach (string f in Find(instance["installationPath"], find))
            {
                Console.WriteLine(f);
            }
            return 0;
        }
        if (property != null)
        {
            string value;
            if (instance.TryGetValue(property, out value))
            {
                Console.WriteLine(value);
            }
            return 0;
        }
        if (format == "json")
        {
            Console.WriteLine(Json(instance));
            return 0;
        }
        foreach (KeyValuePair<string, string> pair in instance)
        {
            Console.WriteLine(pair.Key + ": " + pair.Value);
        }
        return 0;
    }

    static string Json(Dictionary<string, string> instance)
    {
        StringBuilder sb = new StringBuilder("[\n  {\n");
        int n = 0;
        foreach (KeyValuePair<string, string> pair in instance)
        {
            n++;
            sb.Append("    \"" + pair.Key + "\": \"" + pair.Value.Replace("\\", "\\\\") + "\"" + (n < instance.Count ? ",\n" : "\n"));
        }
        sb.Append("  }\n]");
        return sb.ToString();
    }

    static string Read(string json, string key)
    {
        Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        return m.Success ? Regex.Unescape(m.Groups[1].Value) : "";
    }

    // -find with * and ** (e.g. VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe), relative to the installation.
    static IEnumerable<string> Find(string root, string pattern)
    {
        string regex = "^" + Regex.Escape(pattern.Replace('/', '\\')).Replace("\\*\\*\\\\", "(?:.*\\\\)?").Replace("\\*\\*", ".*").Replace("\\*", "[^\\\\]*") + "$";
        Regex re = new Regex(regex, RegexOptions.IgnoreCase);
        List<string> results = new List<string>();
        if (!Directory.Exists(root))
        {
            return results;
        }
        foreach (string file in Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories))
        {
            string rel = file.Substring(root.TrimEnd('\\').Length + 1);
            if (re.IsMatch(rel))
            {
                results.Add(file);
            }
            if (results.Count >= MaxFindResults)
            {
                break;
            }
        }
        return results;
    }
}
