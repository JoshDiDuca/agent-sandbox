// Minimal JSON output for HcsHost's response file: one flat object of strings and a boolean. Requests are read with
// JavaScriptSerializer (System.Web.Extensions, part of .NET 4.x).
using System.Collections.Generic;
using System.Text;

namespace AgentSandbox.HcsHost
{
    public static class Json
    {
        public static string Quote(string text)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            if (text != null)
            {
                foreach (char ch in text)
                {
                    if (ch == '"')
                    {
                        sb.Append("\\\"");
                    }
                    else if (ch == '\\')
                    {
                        sb.Append("\\\\");
                    }
                    else if (ch == '\n')
                    {
                        sb.Append("\\n");
                    }
                    else if (ch == '\r')
                    {
                        sb.Append("\\r");
                    }
                    else if (ch == '\t')
                    {
                        sb.Append("\\t");
                    }
                    else if (ch < ' ')
                    {
                        sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    }
                    else
                    {
                        sb.Append(ch);
                    }
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        /// <summary>{"ok":..,"hresult":"0x..","message":"..","json":"..","values":{..}}</summary>
        public static string Response(bool ok, int hresult, string message, string json, IDictionary<string, string> values)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":").Append(ok ? "true" : "false");
            sb.Append(",\"hresult\":").Append(Quote("0x" + hresult.ToString("X8")));
            sb.Append(",\"message\":").Append(Quote(message));
            sb.Append(",\"json\":").Append(Quote(json));
            sb.Append(",\"values\":{");
            bool first = true;
            if (values != null)
            {
                foreach (KeyValuePair<string, string> pair in values)
                {
                    if (!first)
                    {
                        sb.Append(',');
                    }
                    first = false;
                    sb.Append(Quote(pair.Key)).Append(':').Append(Quote(pair.Value));
                }
            }
            sb.Append("}}");
            return sb.ToString();
        }
    }
}
