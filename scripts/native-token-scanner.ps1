<#
.SYNOPSIS
    Antigravity Native Token & Telemetry Engine (by q1u)
    100% self-calculating, zero external app dependency.
    Directly scans Antigravity SQLite conversation databases via Windows native winsqlite3.dll
    and decodes Protobuf wire formats to calculate exact Token totals, TTFT, body speed, and model distributions.
#>

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class NativeTokenScanner {
    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_open16", CharSet = CharSet.Unicode)]
    public static extern int Open(string filename, out IntPtr db);

    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_close")]
    public static extern int Close(IntPtr db);

    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_prepare16_v2", CharSet = CharSet.Unicode)]
    public static extern int Prepare(IntPtr db, string sql, int numBytes, out IntPtr stmt, IntPtr tail);

    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_step")]
    public static extern int Step(IntPtr stmt);

    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_finalize")]
    public static extern int Finalize(IntPtr stmt);

    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_column_int64")]
    public static extern long ColumnInt64(IntPtr stmt, int col);

    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_column_bytes")]
    public static extern int ColumnBytes(IntPtr stmt, int col);

    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_column_blob")]
    public static extern IntPtr ColumnBlob(IntPtr stmt, int col);

    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_column_text16", CharSet = CharSet.Unicode)]
    public static extern IntPtr ColumnText(IntPtr stmt, int col);

    [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_busy_timeout")]
    public static extern int BusyTimeout(IntPtr db, int ms);

    public static ulong? DecodeVarint(byte[] bytes, ref int offset) {
        if (offset >= bytes.Length) return null;
        ulong value = 0;
        for (int i = 0; i < 10; i++) {
            if (offset >= bytes.Length) return null;
            byte b = bytes[offset++];
            ulong payload = (ulong)(b & 0x7F);
            if (i == 9 && payload > 1) return null;
            value |= (payload << (i * 7));
            if ((b & 0x80) == 0) return value;
        }
        return null;
    }

    public static byte[] GetBytesField(uint fieldNum, byte[] bytes) {
        if (bytes == null) return null;
        int offset = 0;
        while (offset < bytes.Length) {
            ulong? tag = DecodeVarint(bytes, ref offset);
            if (!tag.HasValue) return null;
            uint num = (uint)(tag.Value >> 3);
            int wireType = (int)(tag.Value & 0x7);
            if (num == 0) return null;

            if (wireType == 0) {
                ulong? v = DecodeVarint(bytes, ref offset);
                if (!v.HasValue) return null;
            } else if (wireType == 1) {
                offset += 8;
                if (offset > bytes.Length) return null;
            } else if (wireType == 5) {
                offset += 4;
                if (offset > bytes.Length) return null;
            } else if (wireType == 2) {
                ulong? len = DecodeVarint(bytes, ref offset);
                if (!len.HasValue || (int)len.Value < 0) return null;
                int length = (int)len.Value;
                if (offset + length > bytes.Length) return null;
                if (num == fieldNum) {
                    byte[] slice = new byte[length];
                    Array.Copy(bytes, offset, slice, 0, length);
                    return slice;
                }
                offset += length;
            } else {
                return null;
            }
        }
        return null;
    }

    public static ulong? GetVarintField(uint fieldNum, byte[] bytes) {
        if (bytes == null) return null;
        int offset = 0;
        while (offset < bytes.Length) {
            ulong? tag = DecodeVarint(bytes, ref offset);
            if (!tag.HasValue) return null;
            uint num = (uint)(tag.Value >> 3);
            int wireType = (int)(tag.Value & 0x7);
            if (num == 0) return null;

            if (wireType == 0) {
                ulong? v = DecodeVarint(bytes, ref offset);
                if (!v.HasValue) return null;
                if (num == fieldNum) return v.Value;
            } else if (wireType == 1) {
                offset += 8;
                if (offset > bytes.Length) return null;
            } else if (wireType == 5) {
                offset += 4;
                if (offset > bytes.Length) return null;
            } else if (wireType == 2) {
                ulong? len = DecodeVarint(bytes, ref offset);
                if (!len.HasValue) return null;
                offset += (int)len.Value;
                if (offset > bytes.Length) return null;
            } else {
                return null;
            }
        }
        return null;
    }

    public static string GetStringField(uint fieldNum, byte[] bytes) {
        byte[] b = GetBytesField(fieldNum, bytes);
        if (b == null || b.Length == 0) return null;
        try {
            string s = Encoding.UTF8.GetString(b).Trim();
            return string.IsNullOrEmpty(s) ? null : s;
        } catch { return null; }
    }

    public static double? GetDuration(byte[] bytes) {
        if (bytes == null) return null;
        ulong seconds = GetVarintField(1, bytes) ?? 0;
        ulong nanos = GetVarintField(2, bytes) ?? 0;
        if (seconds > (ulong)long.MaxValue || nanos >= 1000000000) return null;
        double val = (double)seconds + ((double)nanos / 1000000000.0);
        return (val > 0 && !double.IsInfinity(val) && !double.IsNaN(val)) ? (double?)val : null;
    }

    public class Sample {
        public string model;
        public string source;
        public long timestamp;
        public double first_text_seconds;
        public double body_tokens_per_second;
    }

    public class Event {
        public string model;
        public ulong input_tokens;
        public ulong output_tokens;
        public ulong cached_tokens;
        public ulong total_tokens;
        public long timestamp_seconds;
    }

    public class Totals {
        public ulong input_tokens = 0;
        public ulong output_tokens = 0;
        public ulong cached_tokens = 0;
        public ulong total_tokens = 0;
        public ulong request_count = 0;

        public void Add(Event e) {
            input_tokens += e.input_tokens;
            output_tokens += e.output_tokens;
            cached_tokens += e.cached_tokens;
            total_tokens += e.total_tokens;
            request_count += 1;
        }
    }

    public static byte[] ReadBlob(IntPtr stmt, int col) {
        int len = ColumnBytes(stmt, col);
        if (len <= 0) return null;
        IntPtr ptr = ColumnBlob(stmt, col);
        if (ptr == IntPtr.Zero) return null;
        byte[] b = new byte[len];
        Marshal.Copy(ptr, b, 0, len);
        return b;
    }

    public static string GetStatsJson() {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string geminiDir = Path.Combine(home, ".gemini");
        List<string> dbFiles = new List<string>();

        if (Directory.Exists(geminiDir)) {
            foreach (var dir in Directory.GetDirectories(geminiDir)) {
                string name = Path.GetFileName(dir);
                if (name.StartsWith("antigravity")) {
                    string convDir = Path.Combine(dir, "conversations");
                    if (Directory.Exists(convDir)) {
                        foreach (var f in Directory.GetFiles(convDir, "*.db")) {
                            dbFiles.Add(f);
                        }
                    }
                }
            }
        }

        List<Sample> samples = new List<Sample>();
        List<Event> events = new List<Event>();
        HashSet<string> scannedSources = new HashSet<string>();
        ulong totalGenerationsScanned = 0;
        ulong skippedLarge = 0;
        ulong unreadable = 0;

        DateTime nowLocal = DateTime.Now;
        DateTime todayDate = nowLocal.Date;
        DateTime start30Days = todayDate.AddDays(-29);
        long start30Sec = new DateTimeOffset(start30Days).ToUnixTimeSeconds();
        long nowSec = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        long maxAge = 7 * 24 * 3600;

        // Scan archive db if exists
        string archivePath = Path.Combine(geminiDir, "antigravity", "token_usage_archive.db");
        HashSet<string> liveSourceKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in dbFiles) {
            string rel = p.Replace('\\', '/');
            int idx = rel.IndexOf("/.gemini/");
            if (idx >= 0) rel = rel.Substring(idx + 9);
            liveSourceKeys.Add(rel);
        }

        Dictionary<string, HashSet<long>> archivedIdsBySource = new Dictionary<string, HashSet<long>>(StringComparer.OrdinalIgnoreCase);
        if (File.Exists(archivePath)) {
            IntPtr arcDb = IntPtr.Zero;
            if (Open(archivePath, out arcDb) == 0) {
                BusyTimeout(arcDb, 2000);
                IntPtr stmt = IntPtr.Zero;
                if (Prepare(arcDb, "SELECT source_key FROM archived_sources", -1, out stmt, IntPtr.Zero) == 0) {
                    while (Step(stmt) == 100) {
                        IntPtr strPtr = ColumnText(stmt, 0);
                        if (strPtr != IntPtr.Zero) {
                            string src = Marshal.PtrToStringUni(strPtr);
                            scannedSources.Add(src);
                        }
                    }
                    Finalize(stmt);
                }

                if (Prepare(arcDb, "SELECT source_key, generation_idx, model, input_tokens, output_tokens, cached_tokens, total_tokens, timestamp_seconds, valid, oversized FROM archived_generations ORDER BY source_key, generation_idx", -1, out stmt, IntPtr.Zero) == 0) {
                    while (Step(stmt) == 100) {
                        string src = Marshal.PtrToStringUni(ColumnText(stmt, 0));
                        long genIdx = ColumnInt64(stmt, 1);
                        scannedSources.Add(src);
                        if (liveSourceKeys.Contains(src)) {
                            if (!archivedIdsBySource.ContainsKey(src)) archivedIdsBySource[src] = new HashSet<long>();
                            archivedIdsBySource[src].Add(genIdx);
                        }
                        totalGenerationsScanned++;
                        long valid = ColumnInt64(stmt, 8);
                        if (valid != 1) {
                            if (ColumnInt64(stmt, 9) == 1) skippedLarge++;
                            continue;
                        }

                        string model = Marshal.PtrToStringUni(ColumnText(stmt, 2));
                        string sInp = Marshal.PtrToStringUni(ColumnText(stmt, 3));
                        string sOut = Marshal.PtrToStringUni(ColumnText(stmt, 4));
                        string sCch = Marshal.PtrToStringUni(ColumnText(stmt, 5));
                        string sTot = Marshal.PtrToStringUni(ColumnText(stmt, 6));
                        long ts = ColumnInt64(stmt, 7);

                        ulong uInp = 0, uOut = 0, uCch = 0, uTot = 0;
                        if (ulong.TryParse(sInp, out uInp) && ulong.TryParse(sOut, out uOut) && ulong.TryParse(sCch, out uCch) && ulong.TryParse(sTot, out uTot)) {
                            if (ts >= start30Sec) {
                                events.Add(new Event {
                                    model = model ?? "未知模型",
                                    input_tokens = uInp,
                                    output_tokens = uOut,
                                    cached_tokens = uCch,
                                    total_tokens = uTot,
                                    timestamp_seconds = ts
                                });
                            }
                        }
                    }
                    Finalize(stmt);
                }
                Close(arcDb);
            }
        }

        foreach (var dbPath in dbFiles) {
            string rel = dbPath.Replace('\\', '/');
            int idx = rel.IndexOf("/.gemini/");
            if (idx >= 0) rel = rel.Substring(idx + 9);
            string sourceKey = rel;
            scannedSources.Add(sourceKey);

            HashSet<long> archivedIds = null;
            archivedIdsBySource.TryGetValue(sourceKey, out archivedIds);

            IntPtr db = IntPtr.Zero;
            if (Open(dbPath, out db) != 0) {
                unreadable++;
                continue;
            }
            BusyTimeout(db, 2000);

            string source = "antigravity";
            try {
                var p = Path.GetDirectoryName(Path.GetDirectoryName(dbPath));
                if (p != null) source = Path.GetFileName(p);
            } catch {}

            // Read steps
            IntPtr stmt = IntPtr.Zero;
            List<Tuple<long?, bool>> stepRecords = new List<Tuple<long?, bool>>();
            if (Prepare(db, "SELECT CASE WHEN length(metadata) <= 65536 THEN metadata ELSE NULL END, status, CASE WHEN length(step_payload) <= 1048576 THEN step_payload ELSE NULL END FROM steps WHERE step_type = 15 ORDER BY idx", -1, out stmt, IntPtr.Zero) == 0) {
                while (Step(stmt) == 100) {
                    byte[] meta = ReadBlob(stmt, 0);
                    long status = ColumnInt64(stmt, 1);
                    byte[] payload = ReadBlob(stmt, 2);

                    long? ts = null;
                    if (meta != null) {
                        byte[] f1 = GetBytesField(1, meta);
                        if (f1 != null) {
                            ulong? sec = GetVarintField(1, f1);
                            if (sec.HasValue && sec.Value > 0) ts = (long)sec.Value;
                        }
                    }

                    bool textComplete = false;
                    if (status == 3 && payload != null) {
                        byte[] response = GetBytesField(20, payload);
                        if (response != null) {
                            ulong? stopReason = GetVarintField(12, response);
                            string textResp = GetStringField(1, response);
                            byte[] toolCalls = GetBytesField(7, response);
                            if (stopReason == 2 && textResp != null && toolCalls == null) {
                                textComplete = true;
                            }
                        }
                    }
                    stepRecords.Add(new Tuple<long?, bool>(ts, textComplete));
                }
                Finalize(stmt);
            }

            // Read gen_metadata
            if (Prepare(db, "SELECT idx, data, length(data) FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx", -1, out stmt, IntPtr.Zero) == 0) {
                int ordinal = 0;
                while (Step(stmt) == 100) {
                    int curOrdinal = ordinal++;
                    long genIdx = ColumnInt64(stmt, 0);
                    bool isArchived = archivedIds != null && archivedIds.Contains(genIdx);
                    if (!isArchived) totalGenerationsScanned++;

                    long blobSize = ColumnInt64(stmt, 2);
                    if (blobSize > 64 * 1024 * 1024) {
                        if (!isArchived) skippedLarge++;
                        continue;
                    }
                    byte[] blob = ReadBlob(stmt, 1);
                    if (blob == null) continue;

                    long? stepTs = null;
                    bool isComplete = false;
                    if (curOrdinal < stepRecords.Count) {
                        stepTs = stepRecords[curOrdinal].Item1;
                        isComplete = stepRecords[curOrdinal].Item2;
                    }

                    byte[] wrapped = GetBytesField(1, blob);
                    if (wrapped == null) continue;

                    // Performance sample
                    if (isComplete && stepTs.HasValue) {
                        byte[] usage = GetBytesField(4, wrapped);
                        if (usage != null) {
                            ulong? bodyTokens = GetVarintField(10, usage);
                            double? firstTextSec = GetDuration(GetBytesField(11, wrapped));
                            double? streamSec = GetDuration(GetBytesField(12, wrapped));
                            if (bodyTokens.HasValue && bodyTokens.Value >= 100 && streamSec.HasValue && streamSec.Value >= 1.0 && firstTextSec.HasValue) {
                                string model = GetStringField(21, wrapped) ?? GetStringField(19, wrapped);
                                if (model != null) {
                                    samples.Add(new Sample {
                                        model = model,
                                        source = source,
                                        timestamp = stepTs.Value,
                                        first_text_seconds = firstTextSec.Value,
                                        body_tokens_per_second = (double)bodyTokens.Value / streamSec.Value
                                    });
                                }
                            }
                        }
                    }

                    if (isArchived) continue;

                    // Generation Event
                    byte[] genUsage = GetBytesField(4, wrapped);
                    if (genUsage != null) {
                        ulong sysPrompt = GetVarintField(1, genUsage) ?? 0;
                        ulong rawInp = GetVarintField(2, genUsage) ?? 0;
                        ulong outTok = GetVarintField(3, genUsage) ?? 0;
                        ulong cacheTok = GetVarintField(5, genUsage) ?? 0;
                        ulong inpTok = sysPrompt + rawInp;
                        bool generated = rawInp != 0 || outTok != 0 || cacheTok != 0;
                        string modelId = GetStringField(19, wrapped);
                        string label = GetStringField(21, wrapped);
                        if ((modelId != null || label != null || generated) && (generated || inpTok != 0)) {
                            byte[] timing = GetBytesField(9, wrapped);
                            byte[] t4 = timing != null ? GetBytesField(4, timing) : null;
                            ulong? embTs = t4 != null ? GetVarintField(1, t4) : null;
                            long? ts = (embTs.HasValue && embTs.Value > 0) ? (long)embTs.Value : stepTs;
                            if (ts.HasValue && ts.Value >= start30Sec) {
                                events.Add(new Event {
                                    model = label ?? modelId ?? "未知模型",
                                    input_tokens = inpTok,
                                    output_tokens = outTok,
                                    cached_tokens = cacheTok,
                                    total_tokens = inpTok + cacheTok + outTok,
                                    timestamp_seconds = ts.Value
                                });
                            }
                        }
                    }
                }
                Finalize(stmt);
            }
            Close(db);
        }

        // Summarize performance
        samples.RemoveAll(s => s.timestamp < nowSec - maxAge || s.timestamp > nowSec);
        samples.Sort((a, b) => b.timestamp.CompareTo(a.timestamp));

        int sampleLimit = Math.Min(10, samples.Count);
        List<Sample> recent = samples.GetRange(0, sampleLimit);
        string perfJson = "null";
        if (recent.Count > 0) {
            List<double> ttfts = new List<double>();
            List<double> speeds = new List<double>();
            HashSet<string> models = new HashSet<string>();
            HashSet<string> sources = new HashSet<string>();
            foreach (var s in recent) {
                ttfts.Add(s.first_text_seconds);
                speeds.Add(s.body_tokens_per_second);
                models.Add(s.model);
                sources.Add(s.source);
            }
            ttfts.Sort();
            speeds.Sort();
            double medTtft = ttfts.Count % 2 == 0 ? (ttfts[ttfts.Count / 2 - 1] + ttfts[ttfts.Count / 2]) / 2.0 : ttfts[ttfts.Count / 2];
            double medSpeed = speeds.Count % 2 == 0 ? (speeds[speeds.Count / 2 - 1] + speeds[speeds.Count / 2]) / 2.0 : speeds[speeds.Count / 2];
            perfJson = string.Format(System.Globalization.CultureInfo.InvariantCulture,
                "{{\"model_count\":{0},\"source_count\":{1},\"sample_count\":{2},\"first_text_seconds\":{3:F7},\"body_tokens_per_second\":{4:F7},\"last_activity\":{5}}}",
                models.Count, sources.Count, recent.Count, medTtft, medSpeed, recent[0].timestamp);
        }

        // Aggregate Token totals
        events.Sort((a, b) => a.timestamp_seconds.CompareTo(b.timestamp_seconds));
        Totals todayTot = new Totals();
        Totals yestTot = new Totals();
        Totals d3Tot = new Totals();
        Totals d7Tot = new Totals();
        Totals d30Tot = new Totals();

        DateTime yestDate = todayDate.AddDays(-1);
        DateTime d3Start = todayDate.AddDays(-2);
        DateTime d7Start = todayDate.AddDays(-6);
        DateTime d30Start = todayDate.AddDays(-29);

        SortedDictionary<string, Totals> daily = new SortedDictionary<string, Totals>();
        SortedDictionary<string, Totals> hourly = new SortedDictionary<string, Totals>();
        Dictionary<string, Totals> byModelToday = new Dictionary<string, Totals>();
        Dictionary<string, Totals> byModelYesterday = new Dictionary<string, Totals>();
        Dictionary<string, Totals> byModel3Days = new Dictionary<string, Totals>();
        Dictionary<string, Totals> byModel7Days = new Dictionary<string, Totals>();
        Dictionary<string, Totals> byModel30Days = new Dictionary<string, Totals>();

        long lastAct = 0;

        foreach (var e in events) {
            DateTime dt = DateTimeOffset.FromUnixTimeSeconds(e.timestamp_seconds).ToLocalTime().DateTime;
            DateTime date = dt.Date;
            string dateStr = date.ToString("yyyy-MM-dd");
            string hourStr = dt.ToString("yyyy-MM-dd HH:00");

            d30Tot.Add(e);
            if (!daily.ContainsKey(dateStr)) daily[dateStr] = new Totals();
            daily[dateStr].Add(e);
            if (!hourly.ContainsKey(hourStr)) hourly[hourStr] = new Totals();
            hourly[hourStr].Add(e);

            if (!byModel30Days.ContainsKey(e.model)) byModel30Days[e.model] = new Totals();
            byModel30Days[e.model].Add(e);

            if (date == todayDate) {
                todayTot.Add(e);
                if (!byModelToday.ContainsKey(e.model)) byModelToday[e.model] = new Totals();
                byModelToday[e.model].Add(e);
            }
            if (date == yestDate) {
                yestTot.Add(e);
                if (!byModelYesterday.ContainsKey(e.model)) byModelYesterday[e.model] = new Totals();
                byModelYesterday[e.model].Add(e);
            }
            if (date >= d3Start && date <= todayDate) {
                d3Tot.Add(e);
                if (!byModel3Days.ContainsKey(e.model)) byModel3Days[e.model] = new Totals();
                byModel3Days[e.model].Add(e);
            }
            if (date >= d7Start && date <= todayDate) {
                d7Tot.Add(e);
                if (!byModel7Days.ContainsKey(e.model)) byModel7Days[e.model] = new Totals();
                byModel7Days[e.model].Add(e);
            }

            if (e.timestamp_seconds > lastAct) lastAct = e.timestamp_seconds;
        }

        Func<Totals, string> toJson = t => string.Format(System.Globalization.CultureInfo.InvariantCulture,
            "{{\"input_tokens\":{0},\"output_tokens\":{1},\"cached_tokens\":{2},\"total_tokens\":{3},\"request_count\":{4}}}",
            t.input_tokens, t.output_tokens, t.cached_tokens, t.total_tokens, t.request_count);

        Func<Dictionary<string, Totals>, string> modelsToJson = dict => {
            List<KeyValuePair<string, Totals>> list = new List<KeyValuePair<string, Totals>>(dict);
            list.Sort((a, b) => b.Value.total_tokens.CompareTo(a.Value.total_tokens));
            List<string> parts = new List<string>();
            foreach (var kvp in list) {
                parts.Add(string.Format(System.Globalization.CultureInfo.InvariantCulture,
                    "{{\"model\":{0},\"input_tokens\":{1},\"output_tokens\":{2},\"cached_tokens\":{3},\"total_tokens\":{4},\"request_count\":{5}}}",
                    EscapeJson(kvp.Key), kvp.Value.input_tokens, kvp.Value.output_tokens, kvp.Value.cached_tokens, kvp.Value.total_tokens, kvp.Value.request_count));
            }
            return "[" + string.Join(",", parts.ToArray()) + "]";
        };

        List<string> dailyList = new List<string>();
        foreach (var kvp in daily) {
            dailyList.Add(string.Format(System.Globalization.CultureInfo.InvariantCulture,
                "{{\"date\":\"{0}\",\"input_tokens\":{1},\"output_tokens\":{2},\"cached_tokens\":{3},\"total_tokens\":{4},\"request_count\":{5}}}",
                kvp.Key, kvp.Value.input_tokens, kvp.Value.output_tokens, kvp.Value.cached_tokens, kvp.Value.total_tokens, kvp.Value.request_count));
        }

        List<string> hourlyList = new List<string>();
        foreach (var kvp in hourly) {
            hourlyList.Add(string.Format(System.Globalization.CultureInfo.InvariantCulture,
                "{{\"hour\":\"{0}\",\"input_tokens\":{1},\"output_tokens\":{2},\"cached_tokens\":{3},\"total_tokens\":{4},\"request_count\":{5}}}",
                kvp.Key, kvp.Value.input_tokens, kvp.Value.output_tokens, kvp.Value.cached_tokens, kvp.Value.total_tokens, kvp.Value.request_count));
        }

        StringBuilder sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"recent_performance\":" + perfJson + ",");
        sb.Append("\"today\":" + toJson(todayTot) + ",");
        sb.Append("\"yesterday\":" + toJson(yestTot) + ",");
        sb.Append("\"last_3_days\":" + toJson(d3Tot) + ",");
        sb.Append("\"last_7_days\":" + toJson(d7Tot) + ",");
        sb.Append("\"last_30_days\":" + toJson(d30Tot) + ",");
        sb.Append("\"daily\":[" + string.Join(",", dailyList.ToArray()) + "],");
        sb.Append("\"hourly\":[" + string.Join(",", hourlyList.ToArray()) + "],");
        sb.Append("\"by_model_today\":" + modelsToJson(byModelToday) + ",");
        sb.Append("\"by_model_yesterday\":" + modelsToJson(byModelYesterday) + ",");
        sb.Append("\"by_model_3_days\":" + modelsToJson(byModel3Days) + ",");
        sb.Append("\"by_model_7_days\":" + modelsToJson(byModel7Days) + ",");
        sb.Append("\"by_model\":" + modelsToJson(byModel30Days) + ",");
        sb.Append(string.Format(System.Globalization.CultureInfo.InvariantCulture,
            "\"databases_scanned\":{0},\"generations_scanned\":{1},\"skipped_large_records\":{2},\"unreadable_databases\":{3},\"last_activity\":{4},\"generated_at\":{5}",
            scannedSources.Count, totalGenerationsScanned, skippedLarge, unreadable, lastAct > 0 ? (object)lastAct : "null", nowSec));
        sb.Append("}");
        return sb.ToString();
    }

    private static string EscapeJson(string s) {
        if (s == null) return "\"\"";
        return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r") + "\"";
    }
}
"@

[NativeTokenScanner]::GetStatsJson()
