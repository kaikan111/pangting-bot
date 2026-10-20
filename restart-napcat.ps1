# Elevated: restart QQ through NapCat's own launcher and capture its console output.
# Requires admin (UAC). Set NAPCAT_DIR below (or via env) to where NapCat is installed.
param([string]$NapCatDir = '')
if (-not $NapCatDir) { $NapCatDir = $env:NAPCAT_DIR }
if (-not $NapCatDir) { $NapCatDir = 'C:\Napcat\napcat' }
$log = (Join-Path $PSScriptRoot 'napcat-restart.log')
$bootLog = (Join-Path $PSScriptRoot 'napcat-boot.log')
function Note([string]$m) { Add-Content -Path $log -Value ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m) }
Note '--- v3 begin (launcher-win10.bat)'
Get-Process NapCatWinBootMain -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; Note ('killed boot ' + $_.Id) } catch { Note ('kill boot failed ' + $_.Id) } }
Get-Process QQ -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; Note ('killed QQ ' + $_.Id) } catch { Note ('kill QQ failed ' + $_.Id) } }
Start-Sleep -Seconds 3
if (Test-Path $bootLog) { Remove-Item $bootLog -Force -ErrorAction SilentlyContinue }
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',(Join-Path $PSScriptRoot 'boot-napcat.bat') -WorkingDirectory $NapCatDir -PassThru -WindowStyle Minimized
Note ('bat pid=' + $p.Id)
for ($i=0; $i -lt 10; $i++) {
  Start-Sleep -Seconds 3
  $qq = Get-Process QQ -ErrorAction SilentlyContinue
  Note ('t+' + (($i+1)*3) + 's QQ=' + (($qq | ForEach-Object { $_.Id }) -join ','))
  if ($qq) { break }
}
if (Test-Path $bootLog) { Note '--- boot log ---'; Get-Content $bootLog -Tail 50 -Encoding utf8 | ForEach-Object { Note $_ } } else { Note 'no boot log' }