param([string]$Url = 'http://127.0.0.1:19391', [switch]$SmokeTest, [int]$DebugPort = 0)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LauncherWindowFocus {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
}
'@
    $existingWindow = [LauncherWindowFocus]::FindWindow($null, 'DSH Launcher - Release')
    if ($existingWindow -ne [IntPtr]::Zero -and -not $SmokeTest -and $DebugPort -eq 0) {
        if ([LauncherWindowFocus]::IsIconic($existingWindow)) { $null = [LauncherWindowFocus]::ShowWindow($existingWindow, 9) }
        $null = [LauncherWindowFocus]::SetForegroundWindow($existingWindow)
        exit 0
    }
    $nativeBin = Join-Path $PSScriptRoot 'bin'
    $env:PATH = $nativeBin + ';' + $env:PATH
    $null = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes((Join-Path $nativeBin 'Microsoft.Web.WebView2.Core.dll')))
    $null = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes((Join-Path $nativeBin 'Microsoft.Web.WebView2.Wpf.dll')))
    $window = New-Object System.Windows.Window
    $window.Title = 'DSH Launcher - Release'
    $window.Width = 1071
    $window.Height = 640
    $window.MinWidth = 700
    $window.MinHeight = 470
    $window.WindowStyle = 'None'
    $window.ResizeMode = 'CanResize'
    $window.WindowStartupLocation = 'CenterScreen'
    $window.Background = [Windows.Media.Brushes]::White
    $window.UseLayoutRounding = $true
    $window.SnapsToDevicePixels = $true
    $chrome = New-Object System.Windows.Shell.WindowChrome
    $chrome.CaptionHeight = 0
    $chrome.ResizeBorderThickness = New-Object System.Windows.Thickness 5
    $chrome.GlassFrameThickness = New-Object System.Windows.Thickness 0
    $chrome.CornerRadius = New-Object System.Windows.CornerRadius 0
    [System.Windows.Shell.WindowChrome]::SetWindowChrome($window, $chrome)
    $window.add_SourceInitialized({
        $dpi = [Windows.Media.VisualTreeHelper]::GetDpi($window).DpiScaleX
        $window.Width = 1071 / $dpi
        $window.Height = 640 / $dpi
        $window.MinWidth = 700 / $dpi
        $window.MinHeight = 470 / $dpi
    })
    $web = New-Object Microsoft.Web.WebView2.Wpf.WebView2
    $web.UseLayoutRounding = $true
    $web.SnapsToDevicePixels = $true
    $properties = New-Object Microsoft.Web.WebView2.Wpf.CoreWebView2CreationProperties
    $properties.UserDataFolder = Join-Path $env:DSH_LAUNCHER_DATA 'webview-profile'
    if ($DebugPort -gt 0) { $properties.AdditionalBrowserArguments = '--remote-debugging-port=' + $DebugPort }
    $web.CreationProperties = $properties
    $window.Content = $web
    $web.add_CoreWebView2InitializationCompleted({
        param($sender, $eventArgs)
        if (-not $eventArgs.IsSuccess) {
            [Windows.MessageBox]::Show($eventArgs.InitializationException.Message, 'DSH Launcher') | Out-Null
            $window.Close()
            return
        }
        $web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = $false
        $web.CoreWebView2.Settings.IsStatusBarEnabled = $false
        $web.CoreWebView2.Settings.IsZoomControlEnabled = $false
        # Let WebView2 treat CSS app-region as an actual native caption, including
        # dragging, double-click maximize/restore and drag from maximized state.
        $web.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = $true
        $web.CoreWebView2.add_WebMessageReceived({
            param($messageSender, $messageArgs)
            if (-not $messageArgs.Source.StartsWith($Url + '/')) { return }
            $message = $messageArgs.TryGetWebMessageAsString()
            if ($message.StartsWith('{')) {
                try {
                    $request = $message | ConvertFrom-Json
                    if ($request.type -eq 'open-folder' -and [IO.Path]::IsPathRooted($request.path) -and [IO.Directory]::Exists($request.path) -and $request.path -notmatch '["\r\n]') {
                        Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $request.path + '"')
                    }
                } catch { }
                return
            }
            switch ($message) {
                'desktop:choose' {
                    $picker = New-Object Microsoft.Win32.OpenFileDialog
                    $picker.Title = '选择 DeepSeek Harness 桌面程序'
                    $picker.Filter = 'DeepSeek Harness (DeepSeek Harness.exe)|DeepSeek Harness.exe|可执行文件 (*.exe)|*.exe'
                    if ($picker.ShowDialog($window)) {
                        $selectedPath = ConvertTo-Json -InputObject $picker.FileName -Compress
                        $null = $web.CoreWebView2.ExecuteScriptAsync("window.dshDesktopSelected($selectedPath)")
                    }
                }
                'window:minimize' { $window.WindowState = 'Minimized' }
                'window:close' { $window.Close() }
                'window:toggle-maximize' { if ($window.WindowState -eq 'Maximized') { $window.WindowState = 'Normal' } else { $window.WindowState = 'Maximized' } }
            }
        })
        $web.CoreWebView2.add_NewWindowRequested({
            param($newWindowSender, $newWindowArgs)
            $newWindowArgs.Handled = $true
            $destination = [Uri]$newWindowArgs.Uri
            if ($destination.Scheme -in @('http','https')) { Start-Process $destination.AbsoluteUri }
        })
        $web.CoreWebView2.add_NavigationStarting({
            param($navigationSender, $navigationArgs)
            if (-not $navigationArgs.Uri.StartsWith($Url + '/')) { $navigationArgs.Cancel = $true }
        })
        # Match the reference in physical pixels, including Windows text scaling.
        $script:calibrated = $false
        $web.CoreWebView2.add_NavigationCompleted({
            param($navigationSender, $navigationArgs)
            if (-not $navigationArgs.IsSuccess -or $script:calibrated) { return }
            $script:calibrated = $true
            $script:scaleTask = $web.CoreWebView2.ExecuteScriptAsync('window.devicePixelRatio')
            $script:scalePhase = 0
            $script:scaleTimer = New-Object Windows.Threading.DispatcherTimer
            $script:scaleTimer.Interval = [TimeSpan]::FromMilliseconds(50)
            $script:scaleTimer.add_Tick({
                if ($script:scalePhase -eq 0) {
                    if (-not $script:scaleTask.IsCompleted) { return }
                    $ratio = [double]::Parse($script:scaleTask.Result, [Globalization.CultureInfo]::InvariantCulture)
                    $web.ZoomFactor = $web.ZoomFactor / $ratio
                    $script:scalePhase = 1
                    $script:scaleTimer.Interval = [TimeSpan]::FromMilliseconds(150)
                    return
                }
                if ($script:scalePhase -eq 1) {
                    $script:scaleTask = $web.CoreWebView2.ExecuteScriptAsync('({width:innerWidth,height:innerHeight})')
                    $script:scalePhase = 2
                    return
                }
                if ($script:scalePhase -eq 2) {
                    if (-not $script:scaleTask.IsCompleted) { return }
                    $bounds = $script:scaleTask.Result | ConvertFrom-Json
                    $dpi = [Windows.Media.VisualTreeHelper]::GetDpi($window).DpiScaleX
                    # Account for integer rounding in WebView2's native bounds.
                    $window.Width -= ($bounds.width - 1071) / $dpi
                    $window.Height -= ($bounds.height - 640) / $dpi
                    $script:scalePhase = 3
                    return
                }
                $script:scaleTimer.Stop()
                $null = $web.CoreWebView2.ExecuteScriptAsync('requestAnimationFrame(()=>{document.documentElement.dataset.nativeScale="ready";document.documentElement.dataset.nativeDrag="enabled"})')
                if ($SmokeTest) {
                    Set-Content -LiteralPath (Join-Path $env:DSH_LAUNCHER_DATA 'smoke-native.txt') -Value 'WebView2 navigation OK; WindowStyle=None; physical-pixel scale calibrated; native caption regions enabled' -Encoding UTF8
                    $window.Close()
                }
            })
            $script:scaleTimer.Start()
        })
    })
    $web.Source = [Uri]($Url + '/')
    $window.add_Closed({ $web.Dispose() })
    $null = $window.ShowDialog()
} catch {
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $env:DSH_LAUNCHER_DATA 'window-error.log') -Encoding UTF8
    if (-not $SmokeTest) { [Windows.MessageBox]::Show($_.Exception.Message, 'DSH Launcher') | Out-Null }
    exit 1
}
