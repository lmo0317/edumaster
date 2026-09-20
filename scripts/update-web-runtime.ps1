$ErrorActionPreference='Stop'
$taskWorkspace=Split-Path $PSScriptRoot -Parent
$taskRuntime=Get-Content (Join-Path $taskWorkspace 'artifacts/web/runtime.json') | ConvertFrom-Json
$taskProcesses=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @($taskRuntime.watcherPid,$taskRuntime.webPid,$taskRuntime.tunnelPid) }
if($taskProcesses.Count -lt 1){throw 'EduMaster runtime ownership check failed'}
foreach($taskProcess in $taskProcesses){
    if($taskProcess.ProcessId -eq $taskRuntime.webPid -and $taskProcess.ExecutablePath -ne (Join-Path $taskWorkspace 'artifacts/web/EduMaster.Web.exe')){throw 'Wrong web process'}
    if($taskProcess.ProcessId -eq $taskRuntime.watcherPid -and $taskProcess.CommandLine -notlike '*edumaster*start-web.ps1*'){throw 'Wrong watcher'}
    if($taskProcess.ProcessId -eq $taskRuntime.tunnelPid -and $taskProcess.CommandLine -notlike '*18282:127.0.0.1:18280*'){throw 'Wrong tunnel'}
}
Stop-Process -Id $taskRuntime.watcherPid -ErrorAction SilentlyContinue
Stop-Process -Id $taskRuntime.webPid -ErrorAction SilentlyContinue
Stop-Process -Id $taskRuntime.tunnelPid -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Copy-Item (Join-Path $taskWorkspace 'artifacts/web-next/*') (Join-Path $taskWorkspace 'artifacts/web') -Recurse -Force
Start-Process -FilePath 'C:/Users/lmo03/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'start-web.ps1'),'-Watch') -WorkingDirectory $taskWorkspace -WindowStyle Hidden
