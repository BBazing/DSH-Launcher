param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [int]$TargetProcessId = 0,
    [int]$WaitMilliseconds = 0,
    [switch]$Show
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshDesktopWindow {
    public delegate bool Callback(IntPtr window, IntPtr state);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
}
'@
$expectedPath = [IO.Path]::GetFullPath($Executable)
$deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Min(60000, [Math]::Max(0, $WaitMilliseconds)))
do {
    $script:desktopResult = $null
    $callback = [DshDesktopWindow+Callback]{
        param([IntPtr]$window, [IntPtr]$state)
        [uint32]$windowProcessId = 0
        [void][DshDesktopWindow]::GetWindowThreadProcessId($window, [ref]$windowProcessId)
        if ($TargetProcessId -gt 0 -and $windowProcessId -ne $TargetProcessId) { return $true }
        $className = New-Object Text.StringBuilder 256
        [void][DshDesktopWindow]::GetClassName($window, $className, $className.Capacity)
        if ($className.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
        $rect = New-Object DshDesktopWindow+Rect
        if (-not [DshDesktopWindow]::GetWindowRect($window, [ref]$rect)) { return $true }
        $minimized = [DshDesktopWindow]::IsIconic($window)
        if (-not $minimized -and (($rect.Right - $rect.Left) -lt 100 -or ($rect.Bottom - $rect.Top) -lt 100)) { return $true }
        try { $processPath = (Get-Process -Id $windowProcessId -ErrorAction Stop).MainModule.FileName }
        catch { return $true }
        if (-not [string]::Equals($processPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) { return $true }
        if ($Show) {
            # SW_RESTORE handles both a hidden window and a minimized window.
            if ($minimized -or -not [DshDesktopWindow]::IsWindowVisible($window)) {
                [void][DshDesktopWindow]::ShowWindowAsync($window, 9)
            }
            for ($attempt = 0; $attempt -lt 20; $attempt++) {
                if ([DshDesktopWindow]::IsWindowVisible($window) -and -not [DshDesktopWindow]::IsIconic($window)) { break }
                Start-Sleep -Milliseconds 50
            }
            [void][DshDesktopWindow]::SetForegroundWindow($window)
        }
        $script:desktopResult = @{
            pid = [int]$windowProcessId
            handle = $window.ToInt64()
            visible = [DshDesktopWindow]::IsWindowVisible($window)
            minimized = [DshDesktopWindow]::IsIconic($window)
        }
        return $false
    }
    [void][DshDesktopWindow]::EnumWindows($callback, [IntPtr]::Zero)
    if ($script:desktopResult) { $script:desktopResult | ConvertTo-Json -Compress; exit 0 }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Milliseconds 150
} while ($true)
'null'
