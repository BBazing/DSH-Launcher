using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("DSH Launcher")]
[assembly: AssemblyDescription("Independent DeepSeek Harness launcher")]
[assembly: AssemblyVersion("0.3.0.0")]
[assembly: AssemblyFileVersion("0.3.0.0")]

internal static class Program
{
    private static string report;
    private static bool quiet;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        string baseDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DSHLauncher");
        bool extractOnly = false, smoke = false;
        try
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--data-dir" && i + 1 < args.Length) baseDirectory = Path.GetFullPath(args[++i]);
                else if (args[i] == "--report" && i + 1 < args.Length) report = Path.GetFullPath(args[++i]);
                else if (args[i] == "--extract-only") extractOnly = true;
                else if (args[i] == "--smoke-test") smoke = true;
                else throw new ArgumentException("Unknown or incomplete option: " + args[i]);
            }
            quiet = extractOnly || smoke;
            if (!Environment.Is64BitOperatingSystem) throw new Exception("This release requires Windows x64.");
            baseDirectory = Path.GetFullPath(baseDirectory);
            if (baseDirectory.TrimEnd(Path.DirectorySeparatorChar) == Path.GetPathRoot(baseDirectory).TrimEnd(Path.DirectorySeparatorChar)) throw new Exception("Choose a dedicated data folder, not a drive root.");
            string apps = Path.Combine(baseDirectory, "apps");
            string state = Path.Combine(baseDirectory, "data");
            Directory.CreateDirectory(apps);
            Directory.CreateDirectory(state);
            string root = Path.Combine(apps, BuildInfo.Version + "-" + BuildInfo.PayloadHash.Substring(0, 16));
            string lockId = Hash(Encoding.UTF8.GetBytes(baseDirectory.ToUpperInvariant())).Substring(0, 24);
            using (Mutex extractionLock = new Mutex(false, "Local\\DSHLauncher-Extract-" + lockId))
            {
                bool entered = false;
                try
                {
                    try { entered = extractionLock.WaitOne(120000); } catch (AbandonedMutexException) { entered = true; }
                    if (!entered) throw new Exception("Another copy is preparing the launcher. Try again shortly.");
                    EnsureExtracted(root, apps);
                }
                finally { if (entered) extractionLock.ReleaseMutex(); }
            }
            if (!extractOnly)
            {
                string script = Path.Combine(root, "app", "launch-release.ps1");
                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
                start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " + Quote(script) + " -StateHome " + Quote(state) + " -ExecutableDirectory " + Quote(AppDomain.CurrentDomain.BaseDirectory) + (smoke ? " -SmokeTest" : "");
                start.WorkingDirectory = root;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                start.EnvironmentVariables.Remove("NODE_OPTIONS");
                start.EnvironmentVariables["DSH_LAUNCHER_DATA"] = state;
                string temporary = Path.Combine(state, "temp");
                Directory.CreateDirectory(temporary);
                start.EnvironmentVariables["TEMP"] = temporary;
                start.EnvironmentVariables["TMP"] = temporary;
                start.EnvironmentVariables["DSH_LAUNCHER_EXE"] = Assembly.GetExecutingAssembly().Location;
                using (Process child = Process.Start(start))
                {
                    if (!child.WaitForExit(smoke ? 120000 : 90000)) throw new Exception("Startup took too long. See the logs in " + state);
                    if (child.ExitCode != 0) throw new Exception("Startup failed. See " + Path.Combine(state, "bootstrap-error.log"));
                }
            }
            WriteReport(new { ok = true, version = BuildInfo.Version, payloadHash = BuildInfo.PayloadHash, root = root, data = state, extractedOnly = extractOnly, smokeTest = smoke });
            return 0;
        }
        catch (Exception error)
        {
            WriteReport(new { ok = false, error = error.Message });
            if (!quiet) MessageBox.Show(error.Message, "DSH Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string Quote(string value)
    {
        if (value.IndexOfAny(new char[] { '"', '\r', '\n' }) >= 0) throw new ArgumentException("Invalid argument.");
        // Windows command-line quoting requires doubling terminal backslashes.
        int trailing = value.Length - value.TrimEnd('\\').Length;
        return "\"" + value + new string('\\', trailing) + "\"";
    }

    private static void EnsureExtracted(string root, string apps)
    {
        string marker = Path.Combine(root, ".complete");
        if (File.Exists(marker) && File.ReadAllText(marker) == BuildInfo.PayloadHash &&
            File.Exists(Path.Combine(root, "vendor", "node", "node.exe")) &&
            File.Exists(Path.Combine(root, "app", "server", "server.mjs")) &&
            File.Exists(Path.Combine(root, "app", "native", "bin", "WebView2Loader.dll"))) return;
        string staging = Path.Combine(apps, ".extract-" + Guid.NewGuid().ToString("N"));
        Form progress = null;
        try
        {
            if (!quiet)
            {
                progress = new Form { Text = "DSH Launcher", Width = 380, Height = 115, ControlBox = false, FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterScreen };
                progress.Controls.Add(new Label { Text = "正在准备 DSH Launcher，请稍候…", AutoSize = true, Left = 25, Top = 24 });
                progress.Show(); Application.DoEvents();
            }
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (SHA256 sha = SHA256.Create())
            {
                if (resource == null || Hex(sha.ComputeHash(resource)) != BuildInfo.PayloadHash) throw new Exception("The application payload is damaged. Download the EXE again.");
            }
            Directory.CreateDirectory(staging);
            string prefix = Path.GetFullPath(staging) + Path.DirectorySeparatorChar;
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (ZipArchive zip = new ZipArchive(resource, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string target = Path.GetFullPath(Path.Combine(staging, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                    if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new Exception("Unsafe archive entry.");
                    if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream source = entry.Open())
                    using (FileStream output = new FileStream(target, FileMode.CreateNew, FileAccess.Write)) source.CopyTo(output);
                    if (progress != null) Application.DoEvents();
                }
            }
            File.WriteAllText(Path.Combine(staging, ".complete"), BuildInfo.PayloadHash);
            if (Directory.Exists(root)) SafeDelete(root, apps);
            if (!Path.GetFullPath(root).StartsWith(Path.GetFullPath(apps) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("Invalid cache path.");
            Directory.Move(staging, root);
        }
        finally
        {
            if (progress != null) progress.Dispose();
            if (Directory.Exists(staging)) SafeDelete(staging, apps);
        }
    }

    private static void SafeDelete(string target, string parent)
    {
        if (!Path.GetFullPath(target).StartsWith(Path.GetFullPath(parent) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("Refusing to remove a folder outside the application cache.");
        Directory.Delete(target, true);
    }
    private static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
    private static string Hash(byte[] bytes) { using (SHA256 sha = SHA256.Create()) return Hex(sha.ComputeHash(bytes)); }
    private static void WriteReport(object value)
    {
        if (report == null) return;
        Directory.CreateDirectory(Path.GetDirectoryName(report));
        File.WriteAllText(report, Json.Serialize(value), new UTF8Encoding(false));
    }
}
