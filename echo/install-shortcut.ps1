$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = $shell.CreateShortcut((Join-Path $desktop 'Echo - Find a Conversation.lnk'))
$shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'Start Echo.ps1') + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'Find and resume an AI conversation from what you remember.'
$shortcut.Hotkey = 'CTRL+ALT+E'
$shortcut.WindowStyle = 1
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,22"
$shortcut.Save()
Write-Output (Join-Path $desktop 'Echo - Find a Conversation.lnk')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Echo.lnk'
$startShortcut = $shell.CreateShortcut($startMenu)
$startShortcut.TargetPath = $shortcut.TargetPath
$startShortcut.Arguments = $shortcut.Arguments
$startShortcut.WorkingDirectory = $shortcut.WorkingDirectory
$startShortcut.Description = $shortcut.Description
$startShortcut.IconLocation = $shortcut.IconLocation
$startShortcut.Save()
Write-Output $startMenu
