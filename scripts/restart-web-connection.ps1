$ErrorActionPreference='Stop'
$taskWorkspace=Split-Path $PSScriptRoot -Parent
$taskRuntimePath=Join-Path $taskWorkspace 'artifacts/web/runtime.json'
$taskRuntime=Get-Content $taskRuntimePath | ConvertFrom-Json
$taskProcesses=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @($taskRuntime.watcherPid,$taskRuntime.tunnelPid,$taskRuntime.webPid) }
$taskWeb=$taskProcesses | Where-Object ProcessId -eq $taskRuntime.webPid
if($null -eq $taskWeb -or $taskWeb.ExecutablePath -ne (Join-Path $taskWorkspace 'artifacts/web/EduMaster.Web.exe')){throw 'EduMaster web ownership check failed'}
$taskWatcher=$taskProcesses | Where-Object ProcessId -eq $taskRuntime.watcherPid
$taskTunnel=$taskProcesses | Where-Object ProcessId -eq $taskRuntime.tunnelPid
if($taskWatcher -and $taskWatcher.CommandLine -notlike '*edumaster*start-web.ps1*'){throw 'Wrong watcher process'}
if($taskTunnel -and $taskTunnel.CommandLine -notlike '*18282:127.0.0.1:18280*'){throw 'Wrong tunnel process'}
if($taskWatcher){Stop-Process -Id $taskWatcher.ProcessId -ErrorAction SilentlyContinue}
if($taskTunnel){Stop-Process -Id $taskTunnel.ProcessId -ErrorAction SilentlyContinue}
Start-Process -FilePath 'C:/Users/lmo03/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'start-web.ps1'),'-Watch') -WorkingDirectory $taskWorkspace -WindowStyle Hidden
Start-Sleep -Seconds 3
$taskUpdated=Get-Content $taskRuntimePath | ConvertFrom-Json
if($taskUpdated.webPid -ne $taskRuntime.webPid){throw 'Web process changed unexpectedly'}
Get-Process -Id $taskRuntime.webPid -ErrorAction Stop | Out-Null
'WEB_PROCESS_PRESERVED: '+$taskRuntime.webPid
