param(
    [Parameter(Mandatory = $true)][string]$StateHome,
    [string]$ExecutableDirectory = '',
    [switch]$SmokeTest,
    [switch]$Browser
)
$ErrorActionPreference = 'Stop'
$launcherProcess = $null
try {
    $launcherRoot = $PSScriptRoot
    $distributionRoot = Split-Path $launcherRoot -Parent
    $StateHome = [IO.Path]::GetFullPath($StateHome)
    New-Item -ItemType Directory -Path $StateHome -Force | Out-Null
    $env:TEMP = Join-Path $StateHome 'temp'
    $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
    $env:DSH_LAUNCHER_DATA = $StateHome
    $env:DSH_LAUNCHER_CONFIG = Join-Path $StateHome 'launcher.config.json'
    $env:DSH_LAUNCHER_NODE = Join-Path $distributionRoot 'vendor\node\node.exe'
    $env:DSH_LAUNCHER_PNPM = Join-Path $distributionRoot 'vendor\pnpm\bin\pnpm.cjs'
    $env:PNPM_CONFIG_STORE_DIR = Join-Path $StateHome 'pnpm-store'
    $env:PNPM_CONFIG_CACHE_DIR = Join-Path $StateHome 'pnpm-cache'
    $env:PNPM_CONFIG_STATE_DIR = Join-Path $StateHome 'pnpm-state'
    $env:PATH = (Split-Path $env:DSH_LAUNCHER_NODE -Parent) + ';' + $env:PATH
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    if ($SmokeTest) {
        $env:DSH_LAUNCHER_HOME = Join-Path $StateHome 'test-dsh-home'
        New-Item -ItemType Directory -Path $env:DSH_LAUNCHER_HOME -Force | Out-Null
    } else { Remove-Item Env:DSH_LAUNCHER_HOME -ErrorAction SilentlyContinue }
    function Test-DshPath([string]$candidate) {
        return $candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path (Split-Path $candidate -Parent) 'resources\app.asar') -PathType Leaf)
    }
    function Find-DesktopProgram {
        $candidates = New-Object 'System.Collections.Generic.List[string]'
        if ($env:DSH_DESKTOP_EXE) { $candidates.Add($env:DSH_DESKTOP_EXE) }
        foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
            foreach ($key in (Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue)) {
                $entry = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
                if ($entry.DisplayName -match 'DeepSeek\s*Harness') {
                    if ($entry.InstallLocation) { $candidates.Add((Join-Path $entry.InstallLocation 'DeepSeek Harness.exe')) }
                    if ($entry.DisplayIcon -match '^"?(.+?\.exe)"?(?:,\s*-?\d+)?$') { $candidates.Add($Matches[1]) }
                }
            }
        }
        foreach ($base in @($ExecutableDirectory, $env:LOCALAPPDATA, (Join-Path $env:LOCALAPPDATA 'Programs'), $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
            if (-not $base) { continue }
            $candidates.Add((Join-Path $base 'DeepSeek Harness.exe'))
            $candidates.Add((Join-Path $base 'DeepSeek Harness\DeepSeek Harness.exe'))
            $candidates.Add((Join-Path $base 'DSH\DeepSeek Harness.exe'))
        }
        foreach ($drive in [IO.DriveInfo]::GetDrives()) {
            if ($drive.IsReady -and $drive.DriveType -eq 'Fixed') { $candidates.Add((Join-Path $drive.RootDirectory.FullName 'DSH\DeepSeek Harness.exe')) }
        }
        foreach ($candidate in $candidates) { if (Test-DshPath $candidate) { return [IO.Path]::GetFullPath($candidate) } }
        return ''
    }
    $settings = @{ port = 19392; homeMode = 'real'; activeProfile = 'desktop'; desktopExe = ''; registry = 'https://registry.npmmirror.com' }
    if (Test-Path -LiteralPath $env:DSH_LAUNCHER_CONFIG) {
        $saved = Get-Content -LiteralPath $env:DSH_LAUNCHER_CONFIG -Raw | ConvertFrom-Json
        foreach ($property in $saved.PSObject.Properties) { $settings[$property.Name] = $property.Value }
    }
    if ($SmokeTest) { $settings.desktopExe = ''; $env:DSH_DESKTOP_EXE = '' }
    elseif (-not (Test-DshPath $settings.desktopExe)) { $settings.desktopExe = Find-DesktopProgram; $env:DSH_DESKTOP_EXE = $settings.desktopExe }
    if ($SmokeTest) { $portProbe = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback), 0; $portProbe.Start(); $settings.port = $portProbe.LocalEndpoint.Port; $portProbe.Stop() }
    $launcherUrl = 'http://127.0.0.1:' + [int]$settings.port
    $health = $null
    try { $health = Invoke-RestMethod "$launcherUrl/api/health" -TimeoutSec 1 } catch {}
    if ($health -and ($health.app -ne 'dsh-launcher' -or $health.root -ne $launcherRoot)) { throw '已有另一版本启动器运行，请先在旧版本的“更多 → 百宝箱 → 完全退出启动器”退出，再打开新版本。' }
    if (-not $health) {
        $listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback), ([int]$settings.port)
        try { $listener.Start() } catch { throw '启动器端口被占用，请在配置中更换 port，或关闭占用端口的程序。' } finally { $listener.Stop() }
        # Node's JSON reader expects UTF-8 without a BOM.
        [IO.File]::WriteAllText($env:DSH_LAUNCHER_CONFIG, ($settings | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
        $logRoot = Join-Path $StateHome 'logs'
        New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
        $launcherProcess = Start-Process -FilePath $env:DSH_LAUNCHER_NODE -ArgumentList @(('"' + (Join-Path $launcherRoot 'server\server.mjs') + '"')) -WorkingDirectory $launcherRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot 'launcher.out.log') -RedirectStandardError (Join-Path $logRoot 'launcher.err.log')
        for ($attempt = 0; $attempt -lt 100; $attempt++) {
            try { $health = Invoke-RestMethod "$launcherUrl/api/health" -TimeoutSec 1; break } catch {}
            if ($launcherProcess.HasExited) { throw '启动器后台未能启动，请查看 logs\launcher.err.log。' }
            Start-Sleep -Milliseconds 150
        }
        if (-not $health) { throw '启动器后台未能就绪。' }
    }
    if ($SmokeTest) {
        $nodeVersion = & $env:DSH_LAUNCHER_NODE --version
        $pnpmVersion = & $env:DSH_LAUNCHER_NODE $env:DSH_LAUNCHER_PNPM --version
        if ($LASTEXITCODE -ne 0) { throw '内置 pnpm 自检失败。' }
        [IO.File]::WriteAllText((Join-Path $StateHome 'smoke-backend.json'), (@{ node = $nodeVersion; pnpm = $pnpmVersion; health = $health } | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
    }
    $webViewPresent = $false
    $webViewKey = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($key in @("HKCU:\Software\$webViewKey", "HKLM:\Software\WOW6432Node\$webViewKey", "HKLM:\Software\$webViewKey")) {
        $runtimeVersion = (Get-ItemProperty -LiteralPath $key -Name pv -ErrorAction SilentlyContinue).pv
        if ($runtimeVersion -and $runtimeVersion -ne '0.0.0.0') { $webViewPresent = $true }
    }
    if (-not $Browser -and $webViewPresent) {
        $nativeScript = Join-Path $launcherRoot 'native\window.ps1'
        $nativeArgs = @('-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $nativeScript + '"'), '-Url', $launcherUrl)
        if ($SmokeTest) { $nativeArgs += '-SmokeTest' }
        $native = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $nativeArgs -WorkingDirectory $launcherRoot -WindowStyle Hidden -PassThru
        if ($SmokeTest) {
            if (-not $native.WaitForExit(45000)) { $native.Kill(); throw '原生窗口自检超时。' }
            if ($native.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $StateHome 'smoke-native.txt'))) { throw '原生窗口自检失败。' }
        }
    } else {
        if ($SmokeTest) { throw '原生窗口测试需要 WebView2 Runtime。' }
        if (-not $webViewPresent -and -not $Browser) {
            Add-Type -AssemblyName System.Windows.Forms
            $choice = [Windows.Forms.MessageBox]::Show('未检测到 WebView2 Runtime。是否打开微软官方下载页？本次仍可在浏览器中使用启动器。', 'DSH Launcher', 'YesNo', 'Information')
            if ($choice -eq 'Yes') { Start-Process 'https://developer.microsoft.com/microsoft-edge/webview2/' }
        }
        Start-Process $launcherUrl
    }
    exit 0
} catch {
    New-Item -ItemType Directory -Path $StateHome -Force | Out-Null
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $StateHome 'bootstrap-error.log') -Encoding UTF8
    if (-not $SmokeTest) { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'DSH Launcher') | Out-Null }
    exit 1
} finally {
    if ($SmokeTest -and $launcherProcess -and -not $launcherProcess.HasExited) { $launcherProcess.Kill(); $launcherProcess.WaitForExit() }
}
