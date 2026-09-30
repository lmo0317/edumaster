param([switch]$Watch)
# Keeps the free "PC 모델" reachable from the server: the local model on port 8092 (scripts/local-model.txt picks
# which, see start-local-model.ps1) and the SSH reverse tunnel that maps it to the server's 127.0.0.1:18283.
# Started at logon by the scheduled task "EduMaster Web Watcher" (-Watch), whose path is this file.
# A model started by hand with start-local-model.ps1 is left alone, so switching models needs no watcher restart.
$ErrorActionPreference='Stop'
$workspace=Split-Path $PSScriptRoot -Parent
$logs=Join-Path $workspace 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$watchMutex=[Threading.Mutex]::new($false,'Local\EduMasterWebWatcher')
if(-not $watchMutex.WaitOne(0)){exit}
$tunnelProcess=$null
$lastHealthCheck=[DateTime]::MinValue;$healthFailures=0

function Start-LocalModel {
    $pidFile=Join-Path $logs 'local-model-pid.txt'
    $choiceFile=Join-Path $PSScriptRoot 'local-model.txt'
    $name=if(Test-Path -LiteralPath $choiceFile){(Get-Content $choiceFile -Raw).Trim()}else{'qwen36'}
    $mutex=[Threading.Mutex]::new($false,'Local\EduMasterGemmaVisionStarter')
    if(-not $mutex.WaitOne(0)){return}
    try {
        $listener=Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8092 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if($listener){
            try{$models=Invoke-RestMethod -Uri 'http://127.0.0.1:8092/v1/models' -TimeoutSec 4}
            catch{return} # still loading
            if(-not @($models.data | ForEach-Object id | Where-Object {$_ -like 'edumaster-*'}).Count){throw 'PC 모델 포트(8092)를 다른 프로그램이 사용 중입니다.'}
            return
        }
        # A model that is still starting (large models take up to a minute) is given time before trying again.
        if(Test-Path -LiteralPath $pidFile){
            $previousId=0
            if([int]::TryParse((Get-Content $pidFile -Raw).Trim(),[ref]$previousId)){
                $previous=Get-Process -Id $previousId -ErrorAction SilentlyContinue
                if($previous -and $previous.ProcessName -eq 'llama-server' -and ([DateTime]::Now - $previous.StartTime) -lt [TimeSpan]::FromMinutes(3)){return}
            }
        }
        & (Join-Path $PSScriptRoot 'start-local-model.ps1') -Name $name -NoWait
    } finally {$mutex.ReleaseMutex();$mutex.Dispose()}
}

try {
    do {
        try { Start-LocalModel }
        catch { Add-Content (Join-Path $logs 'model-start-error.log') ('{0:o} {1}' -f [DateTime]::UtcNow,$_.Exception.Message) }
        if($null -eq $tunnelProcess -or $tunnelProcess.HasExited){
            $tunnelProcess=Start-Process ssh.exe -ArgumentList '-T -o BatchMode=yes -o ConnectTimeout=8 -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=2 -R 127.0.0.1:18283:127.0.0.1:8092 lmo0317@192.168.219.112 python3 /home/lmo0317/apps/edumaster/deploy/tunnel-guard.py' -WindowStyle Hidden -RedirectStandardError (Join-Path $logs 'tunnel-error.log') -RedirectStandardOutput (Join-Path $logs 'tunnel-out.log') -PassThru
            $healthFailures=0;$lastHealthCheck=[DateTime]::UtcNow
        }
        if($Watch -and ([DateTime]::UtcNow - $lastHealthCheck) -ge [TimeSpan]::FromSeconds(15)){
            $lastHealthCheck=[DateTime]::UtcNow
            # Only a ready local model tells anything about the tunnel: then the server must see it too.
            $ready=$false
            try{$ready=[bool](Invoke-RestMethod -Uri 'http://127.0.0.1:8092/v1/models' -TimeoutSec 3).data}catch{}
            if($ready){
                try{
                    $status=Invoke-RestMethod -Uri 'https://minohlee.mooo.com/edumaster/api/status' -TimeoutSec 5
                    if($status.providers.gemma.available){$healthFailures=0}else{$healthFailures++}
                }catch{$healthFailures++}
            }
            if($healthFailures -ge 2 -and $null -ne $tunnelProcess -and -not $tunnelProcess.HasExited){
                Add-Content (Join-Path $logs 'connection-health.log') ('{0:o} server could not reach the PC model twice; reconnecting owned SSH tunnel' -f [DateTime]::UtcNow)
                Stop-Process -Id $tunnelProcess.Id -ErrorAction SilentlyContinue
                $tunnelProcess=$null
            }
        }
        @{tunnelPid=$tunnelProcess.Id;watcherPid=$PID} | ConvertTo-Json | Set-Content (Join-Path $logs 'runtime.json')
        if($Watch){Start-Sleep -Seconds 5}
    }while($Watch)
}catch{
    Add-Content (Join-Path $logs 'watcher-error.log') ('{0:o} {1}' -f [DateTime]::UtcNow,$_.Exception.ToString())
    throw
}finally{$watchMutex.ReleaseMutex();$watchMutex.Dispose()}
