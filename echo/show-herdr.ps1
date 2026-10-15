param([Parameter(Mandatory=$true)][string]$Title)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class EchoWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
}
'@
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)
foreach ($process in (Get-Process WindowsTerminal -ErrorAction SilentlyContinue)) {
  if ($process.MainWindowHandle -eq 0) { continue }
  $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  $tabs = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
  foreach ($tab in $tabs) {
    if (-not $tab.Current.Name.Contains($Title)) { continue }
    if ([EchoWindow]::IsIconic($process.MainWindowHandle)) { [void][EchoWindow]::ShowWindowAsync($process.MainWindowHandle,9) }
    $selection = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $selection.Select()
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.AppActivate($process.Id)
    $currentThread = [EchoWindow]::GetCurrentThreadId()
    $foregroundThread = [EchoWindow]::GetWindowThreadProcessId([EchoWindow]::GetForegroundWindow(),[IntPtr]::Zero)
    $attached = $false
    try {
      if ($foregroundThread -ne $currentThread) { $attached = [EchoWindow]::AttachThreadInput($currentThread,$foregroundThread,$true) }
      [void][EchoWindow]::SetForegroundWindow($process.MainWindowHandle)
    } finally {
      if ($attached) { [void][EchoWindow]::AttachThreadInput($currentThread,$foregroundThread,$false) }
    }
    @{ shown=([EchoWindow]::GetForegroundWindow() -eq $process.MainWindowHandle) } | ConvertTo-Json -Compress
    exit 0
  }
}
@{ shown=$false } | ConvertTo-Json -Compress
