param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$address = 'http://127.0.0.1:4319'
function Get-NeuroSphereHealth {
  try { return Invoke-RestMethod "$address/api/health" -TimeoutSec 2 } catch { return $null }
}
$health = Get-NeuroSphereHealth
if ($health.app -ne 'NeuroSphere') {
  $nodeExecutable = (Get-Command node -ErrorAction Stop).Source
  $logDirectory = Join-Path $projectDirectory 'outputs\ui'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $serverFile = Join-Path $projectDirectory 'server.cjs'
  $serverProcess = Start-Process -FilePath $nodeExecutable -ArgumentList @(('"' + $serverFile + '"'), '--port', '4319') -WorkingDirectory $projectDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'server.log') -RedirectStandardError (Join-Path $logDirectory 'server-error.log')
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $health = Get-NeuroSphereHealth
    if ($serverProcess.HasExited) { throw 'The server could not start. See outputs\ui\server-error.log. Port 4319 may be in use.' }
  } while ($health.app -ne 'NeuroSphere' -and (Get-Date) -lt $deadline)
  if ($health.app -ne 'NeuroSphere') { throw 'The local server did not become ready. See outputs\ui\server-error.log.' }
  $serverProcess.Id | Set-Content -LiteralPath (Join-Path $logDirectory 'server.pid')
}
Write-Host "NeuroSphere is ready at $address"
if (-not $NoBrowser) { Start-Process $address }
