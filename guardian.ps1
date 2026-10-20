# Guardian: keeps bot.mjs (and panel.mjs) alive. ASCII only on purpose (PS 5.1 reads no-BOM files as ANSI).
# Pause: if .paused exists the bot is NOT started (panel's pause button writes it).
param([string]$BotDir = '')
if (-not $BotDir) { $BotDir = $PSScriptRoot }
Set-Location $BotDir
$log = Join-Path $BotDir 'guardian.log'
function Note([string]$msg) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
  Add-Content -Path $log -Value $line
}
Set-Content -Path (Join-Path $BotDir '.guardian.pid') -Value $PID
Note ('guardian started pid=' + $PID)
$quickCrashes = 0
$script:wasPaused = $false
$script:panel = $null
function Start-Panel {
  $pp = Start-Process -FilePath 'node' -ArgumentList 'panel.mjs' -WorkingDirectory $BotDir -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $BotDir 'panel.out.log') -RedirectStandardError (Join-Path $BotDir 'panel.err.log')
  Set-Content -Path (Join-Path $BotDir '.panel.pid') -Value $pp.Id
  Note ('panel started pid=' + $pp.Id)
  $script:panel = $pp
}
while ($true) {
  if (-not (Test-Path (Join-Path $BotDir '.env'))) { Note 'no .env, guardian exit'; break }
  if ($script:panel -eq $null -or $script:panel.HasExited) { Start-Panel }
  if (Test-Path (Join-Path $BotDir '.paused')) {
    if (-not $script:wasPaused) { Note 'paused by panel, bot stays down'; $script:wasPaused = $true }
    Start-Sleep -Seconds 2
    continue
  }
  if ($script:wasPaused) { Note 'resumed, starting bot'; $script:wasPaused = $false }
  $started = Get-Date
  $p = Start-Process -FilePath 'node' -ArgumentList '--env-file=.env','bot.mjs' -WorkingDirectory $BotDir -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $BotDir 'run.out.log') -RedirectStandardError (Join-Path $BotDir 'run.err.log')
  Set-Content -Path (Join-Path $BotDir '.bot.pid') -Value $p.Id
  Note ('bot started pid=' + $p.Id)
  while (-not $p.HasExited) {
    Start-Sleep -Seconds 2
    if ($script:panel -eq $null -or $script:panel.HasExited) {
      Note 'panel gone, restart in 3s'
      Start-Sleep -Seconds 3
      Start-Panel
    }
  }
  $alive = [int]((Get-Date) - $started).TotalSeconds
  if ($alive -lt 60) { $quickCrashes++ } else { $quickCrashes = 0 }
  $wait = 5
  if ($quickCrashes -ge 3) { $wait = [Math]::Min(60, 5 * $quickCrashes) }
  Note ('bot exited after ' + $alive + 's, restart in ' + $wait + 's')
  Start-Sleep -Seconds $wait
}
