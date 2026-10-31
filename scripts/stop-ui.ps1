$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$serverFile = Join-Path $projectDirectory 'server.cjs'
$pidFile = Join-Path $projectDirectory 'outputs\ui\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No launcher-started NeuroSphere server was found. Use Ctrl+C if you started it in a terminal.'; exit 0 }
$serverProcessId = [int](Get-Content -LiteralPath $pidFile)
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId"
if ($processInfo) {
  if ($processInfo.Name -ne 'node.exe' -or -not $processInfo.CommandLine.Contains(('"' + $serverFile + '"'))) { throw 'The saved process ID belongs to another program. No process was stopped.' }
  Stop-Process -Id $serverProcessId
}
Remove-Item -LiteralPath $pidFile
Write-Host 'NeuroSphere stopped. Your saved memories are still on disk.'
