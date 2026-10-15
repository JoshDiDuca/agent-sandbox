// What HcsHost may touch: only compute systems this tool created (id prefix and Owner), and only disk files it made
// (.vhdx, not a link). A wrong or tampered id can never reach Windows Sandbox, WSL, Docker or anything else on this PC.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace AgentSandbox.HcsHost
{
    public static class Guard
    {
        public const string IdPrefix = "agent-sandbox-";
        public const string Owner = "agent-sandbox";
        private const int MaxIdLength = 120;
        private static readonly Regex SafeId = new Regex("^agent-sandbox-[A-Za-z0-9._-]{1,100}$");

        /// <summary>Null when the id is one of ours by its shape; otherwise why not.</summary>
        public static string IdProblem(string id)
        {
            if (id == null || id.Length > MaxIdLength || !SafeId.IsMatch(id))
            {
                return "only compute systems whose id starts with " + IdPrefix + " can be used";
            }
            return null;
        }

        /// <summary>Null when an HCS document says it belongs to this tool (top-level "Owner").</summary>
        public static string DocumentProblem(string document)
        {
            Dictionary<string, object> parsed;
            try
            {
                parsed = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(document);
            }
            catch (ArgumentException)
            {
                return "the document is not JSON";
            }
            catch (InvalidOperationException)
            {
                return "the document is not JSON";
            }
            object owner;
            if (parsed == null || !parsed.TryGetValue("Owner", out owner) || !(owner is string) || (string)owner != Owner)
            {
                return "the document's Owner must be " + Owner;
            }
            return null;
        }

        /// <summary>Null when the running system `id` reports this tool as its Owner (asked from HCS itself).</summary>
        public static string OwnerProblem(string id)
        {
            HcsReply reply = Hcs.Properties(id, "{\"PropertyTypes\":[]}");
            if (!reply.Ok)
            {
                return "its properties could not be read: " + reply.Message();
            }
            Dictionary<string, object> parsed;
            try
            {
                parsed = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reply.Json);
            }
            catch (ArgumentException)
            {
                return "its properties are not JSON";
            }
            catch (InvalidOperationException)
            {
                return "its properties are not JSON";
            }
            object owner;
            if (parsed == null || !parsed.TryGetValue("Owner", out owner) || !(owner is string) || (string)owner != Owner)
            {
                return "it does not belong to this tool (Owner is not " + Owner + ")";
            }
            return null;
        }

        /// <summary>Null when `path` is an existing .vhdx file that is not a link (a disk this tool made).</summary>
        public static string DiskProblem(string path)
        {
            if (string.IsNullOrEmpty(path) || !Path.IsPathRooted(path) || !path.EndsWith(".vhdx", StringComparison.OrdinalIgnoreCase))
            {
                return "only a full path to a .vhdx file can be used";
            }
            FileInfo info = new FileInfo(path);
            if (!info.Exists)
            {
                return "the disk file does not exist";
            }
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                return "the disk file is a link";
            }
            return null;
        }
    }
}
