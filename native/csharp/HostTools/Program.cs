// HostTools.exe: what the host side asks of Windows without PowerShell. Built on first use by host/native.ts (csc).
//   keep-awake --owner-pid N    this PC stays awake until process N ends (sandbox.keepAwake)
//   stop-events --since <iso>   the Windows events since then that can end a sandbox, as JSON (host/life)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Text;

static class Program
{
    private const int MaxEventsPerQuery = 100;
    private const int MaxDetail = 390;

    static int Main(string[] args)
    {
        string command = args.Length > 0 ? args[0] : "";
        Dictionary<string, string> options = Options(args);
        string value;
        switch (command)
        {
            case "keep-awake":
                int pid;
                if (!options.TryGetValue("owner-pid", out value) || !int.TryParse(value, out pid))
                {
                    return Usage();
                }
                KeepAwake(pid);
                return 0;
            case "stop-events":
                DateTime since;
                if (!options.TryGetValue("since", out value) || !DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out since))
                {
                    return Usage();
                }
                Console.Out.Write(StopEventsJson(since));
                return 0;
            default:
                return Usage();
        }
    }

    static int Usage()
    {
        Console.Error.WriteLine("Usage: HostTools keep-awake --owner-pid N | stop-events --since <ISO time>");
        return 2;
    }

    /// <summary>--name value pairs after the command.</summary>
    static Dictionary<string, string> Options(string[] args)
    {
        Dictionary<string, string> options = new Dictionary<string, string>();
        for (int i = 1; i + 1 < args.Length; i += 2)
        {
            if (args[i].StartsWith("--"))
            {
                options[args[i].Substring(2)] = args[i + 1];
            }
        }
        return options;
    }

    static void KeepAwake(int ownerPid)
    {
        AgentSandbox.Power.StayAwake();
        try
        {
            using (Process owner = Process.GetProcessById(ownerPid))
            {
                owner.WaitForExit();
            }
        }
        catch (ArgumentException)
        {
            // The owner has ended already.
        }
    }

    /// <summary>Restarts and shutdowns, power loss, sleep, low memory, this PC's blue screens, the sandbox crashing.</summary>
    static string StopEventsJson(DateTime sinceUtc)
    {
        string time = "TimeCreated[@SystemTime>='" + sinceUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture) + "']";
        string[][] queries =
        {
            new[] { "System", "*[System[(EventID=1074 or EventID=6008 or EventID=41 or EventID=42 or EventID=2004) and " + time + "]]" },
            new[] { "System", "*[System[Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting'] and EventID=1001 and " + time + "]]" },
            new[] { "Microsoft-Windows-Hyper-V-Worker-Admin", "*[System[(EventID=18590 or EventID=40001) and " + time + "]]" },
        };
        List<string> items = new List<string>();
        foreach (string[] query in queries)
        {
            try
            {
                ReadEvents(query[0], query[1], items);
            }
            catch (EventLogException)
            {
                // A log this PC does not have, or no access: nothing to add.
            }
            catch (UnauthorizedAccessException)
            {
                // Same.
            }
        }
        return "[" + string.Join(",", items) + "]";
    }

    /// <summary>The newest events first, at most 100 per query, as JSON objects { at, id, provider, process }.</summary>
    static void ReadEvents(string log, string xpath, List<string> items)
    {
        EventLogQuery query = new EventLogQuery(log, PathType.LogName, xpath);
        query.ReverseDirection = true;
        using (EventLogReader reader = new EventLogReader(query))
        {
            for (int n = 0; n < MaxEventsPerQuery; n++)
            {
                using (EventRecord record = reader.ReadEvent())
                {
                    if (record == null)
                    {
                        return;
                    }
                    DateTime at = record.TimeCreated.HasValue ? record.TimeCreated.Value.ToUniversalTime() : DateTime.UtcNow;
                    items.Add(
                        "{\"at\":" + Json(at.ToString("o", CultureInfo.InvariantCulture)) +
                        ",\"id\":" + record.Id.ToString(CultureInfo.InvariantCulture) +
                        ",\"provider\":" + Json(record.ProviderName ?? "") +
                        ",\"process\":" + Json(Detail(record)) + "}");
                }
            }
        }
    }

    /// <summary>What an event says beyond its id: the program that asked for a restart (1074), else its message start.</summary>
    static string Detail(EventRecord record)
    {
        if (record.Id == 1074)
        {
            return record.Properties.Count > 0 ? Convert.ToString(record.Properties[0].Value, CultureInfo.InvariantCulture) ?? "" : "";
        }
        if (record.Id == 18590 || record.Id == 40001 || record.Id == 1001)
        {
            string message;
            try
            {
                message = record.FormatDescription() ?? "";
            }
            catch (EventLogException)
            {
                message = "";
            }
            return message.Substring(0, Math.Min(MaxDetail, message.Length));
        }
        return "";
    }

    /// <summary>A JSON string literal.</summary>
    static string Json(string value)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in value)
        {
            switch (c)
            {
                case '"':
                    sb.Append("\\\"");
                    break;
                case '\\':
                    sb.Append("\\\\");
                    break;
                default:
                    if (c < 0x20)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    break;
            }
        }
        return sb.Append('"').ToString();
    }
}
