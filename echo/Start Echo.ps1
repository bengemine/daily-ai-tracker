param(
  [switch]$NoOpen,
  # WSL distro that runs Echo. Order: -Distro, $env:ECHO_WSL_DISTRO, the distro in
  # this folder's \\wsl.localhost path, then 'Ubuntu'.
  [string]$Distro = $env:ECHO_WSL_DISTRO
)
$ErrorActionPreference = 'Stop'
$url = 'http://127.0.0.1:4317/'
$statusUrl = 'http://127.0.0.1:4317/api/status'

function Test-EchoReady {
  try {
    $status = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 1
    return $status.app -eq 'echo-conversation-finder'
  } catch {
    return $false
  }
}

if (-not $Distro) {
  if ($PSScriptRoot -match '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\') { $Distro = $Matches[1] } else { $Distro = 'Ubuntu' }
}

if (-not (Test-EchoReady)) {
  # --cd accepts a Windows path (drive or \\wsl.localhost) and opens it inside WSL.
  $arguments = @('-d', $Distro, '--cd', ('"' + $PSScriptRoot + '"'), '--', 'bash', './start.sh')
  $starter = Start-Process -FilePath 'wsl.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (Test-EchoReady) {
      $ready = $true
      break
    }
    if ($starter.HasExited -and $starter.ExitCode -ne 0) { break }
  }
  if (-not $ready) {
    if ($NoOpen) { throw 'Echo could not start.' }
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show('Echo could not start. Open WSL and run: systemctl --user restart echo-conversation-finder.service','Echo')
    exit 1
  }
}

if (-not $NoOpen) { Start-Process $url }
