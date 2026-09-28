param([string]$TaskName='EduMaster Web Watcher')
$ErrorActionPreference='Stop'

$workspace=Split-Path $PSScriptRoot -Parent
$watcherScript=Join-Path $PSScriptRoot 'start-web.ps1'
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
$userId="$env:USERDOMAIN\$env:USERNAME"

$action=New-ScheduledTaskAction `
    -Execute $pwsh `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Watch' -f $watcherScript) `
    -WorkingDirectory $workspace
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings=New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$definition=New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Keeps the EduMaster local backend and reverse SSH tunnel available after Windows logon.'

Register-ScheduledTask -TaskName $TaskName -InputObject $definition -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State,@{Name='Execute';Expression={$_.Actions.Execute}},@{Name='Arguments';Expression={$_.Actions.Arguments}}
