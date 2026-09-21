param([switch]$Watch)
$ErrorActionPreference='Stop'
$workspace=Split-Path $PSScriptRoot -Parent
$webDirectory=Join-Path $workspace 'artifacts/web'
$webExecutable=Join-Path $webDirectory 'EduMaster.Web.exe'
$logs=Join-Path $workspace 'artifacts/evidence/web'
New-Item -ItemType Directory -Force $logs | Out-Null
$watchMutex=[Threading.Mutex]::new($false,'Local\EduMasterWebWatcher')
if(-not $watchMutex.WaitOne(0)){exit}
$webProcess=$null;$tunnelProcess=$null
$taskLastHealthCheck=[DateTime]::MinValue;$taskHealthFailures=0
try {
    do {
        & (Join-Path $PSScriptRoot 'start-vision.ps1')
        & (Join-Path $PSScriptRoot 'start-gemma-vision.ps1')
        if($null -eq $webProcess -or $webProcess.HasExited){
            $listener=Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 18280 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            if($listener){
                $webProcess=Get-Process -Id $listener.OwningProcess
                if($webProcess.Path -ne $webExecutable){throw 'EduMaster 웹 포트를 다른 프로그램이 사용 중입니다.'}
            }else{
                $webProcess=Start-Process -FilePath $webExecutable -WorkingDirectory $webDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'web-out.log') -RedirectStandardError (Join-Path $logs 'web-error.log') -PassThru
            }
        }
        if($null -eq $tunnelProcess -or $tunnelProcess.HasExited){
            $tunnelProcess=Start-Process ssh.exe -ArgumentList '-T -o BatchMode=yes -o ConnectTimeout=8 -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=2 -R 127.0.0.1:18283:127.0.0.1:8092 -R 127.0.0.1:18284:127.0.0.1:8091 lmo0317@192.168.219.112 python3 /home/lmo0317/apps/edumaster/tunnel-guard.py' -WindowStyle Hidden -RedirectStandardError (Join-Path $logs 'tunnel-error.log') -RedirectStandardOutput (Join-Path $logs 'tunnel-out.log') -PassThru
            $taskHealthFailures=0;$taskLastHealthCheck=[DateTime]::UtcNow
        }
        if($Watch -and ([DateTime]::UtcNow - $taskLastHealthCheck) -ge [TimeSpan]::FromSeconds(15)){
            $taskLastHealthCheck=[DateTime]::UtcNow
            try{
                # A 401 proves the full gateway/tunnel/web path works, without sending a credential.
                $taskHealth=Invoke-WebRequest -Uri 'https://minohlee.mooo.com/edumaster/api/status' -TimeoutSec 5 -SkipHttpErrorCheck
                if([int]$taskHealth.StatusCode -eq 401){$taskHealthFailures=0}else{$taskHealthFailures++}
            }catch{$taskHealthFailures++}
            if($taskHealthFailures -ge 2 -and $null -ne $tunnelProcess -and -not $tunnelProcess.HasExited){
                Add-Content (Join-Path $logs 'connection-health.log') ('{0:o} transport health failed twice; reconnecting owned SSH tunnel' -f [DateTime]::UtcNow)
                Stop-Process -Id $tunnelProcess.Id -ErrorAction SilentlyContinue
                $tunnelProcess=$null
            }
        }
        @{webPid=$webProcess.Id;tunnelPid=$tunnelProcess.Id;watcherPid=$PID} | ConvertTo-Json | Set-Content (Join-Path $webDirectory 'runtime.json')
        if($Watch){Start-Sleep -Seconds 5}
    }while($Watch)
}finally{$watchMutex.ReleaseMutex();$watchMutex.Dispose()}
