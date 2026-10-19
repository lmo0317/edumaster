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
$lastSpeedCheck=[DateTime]::UtcNow;$slowChecks=0

# A model that has run for days can drop from ~52 to ~4 tokens a second and stay there (part of it pushed out of the
# GPU's memory and never brought back): 모델 비교 5차's Qwen runs timed out three times from 2026-10-18 13:30 on, and a
# restart of llama-server alone brought 52.7 tok/s back with the same apps open. Measured on an idle model only.
function Test-ModelSpeed {
    try{ if(@(Invoke-RestMethod -Uri 'http://127.0.0.1:8092/slots' -TimeoutSec 3) | Where-Object { $_.is_processing }){return $null} }catch{return $null}
    $body='{"messages":[{"role":"user","content":"Count from 1 to 100 separated by spaces."}],"max_tokens":64,"reasoning_budget":0}'
    try{ return [double](Invoke-RestMethod -Uri 'http://127.0.0.1:8092/v1/chat/completions' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 120).timings.predicted_per_second }catch{ return 0 }
}

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
                # /edumasterv2/ is the address nginx serves until deploy/nginx-edumaster.sh runs (afterwards it redirects).
                $seen=$false
                foreach($url in 'https://minohlee.mooo.com/edumaster/api/status','https://minohlee.mooo.com/edumasterv2/api/status'){
                    try{ if((Invoke-RestMethod -Uri $url -TimeoutSec 5).providers.gemma.available){$seen=$true;break} }catch{}
                }
                # A model busy with a long request answers the server's 2.5 s check late; reconnecting then cut the
                # requests going through the tunnel (both Qwen runs of 모델 비교 3차, 2026-10-17). Busy is not down.
                $busy=$false
                try{$busy=[bool](@(Invoke-RestMethod -Uri 'http://127.0.0.1:8092/slots' -TimeoutSec 3) | Where-Object { $_.is_processing })}catch{}
                if($seen -or $busy){$healthFailures=0}else{$healthFailures++}
            }
            if($healthFailures -ge 2 -and $null -ne $tunnelProcess -and -not $tunnelProcess.HasExited){
                Add-Content (Join-Path $logs 'connection-health.log') ('{0:o} server could not reach the PC model twice; reconnecting owned SSH tunnel' -f [DateTime]::UtcNow)
                Stop-Process -Id $tunnelProcess.Id -ErrorAction SilentlyContinue
                $tunnelProcess=$null
            }
        }
        if($Watch -and ([DateTime]::UtcNow - $lastSpeedCheck) -ge [TimeSpan]::FromMinutes(10)){
            $lastSpeedCheck=[DateTime]::UtcNow
            $speed=Test-ModelSpeed
            if($null -ne $speed){
                if($speed -lt 15){$slowChecks++}else{$slowChecks=0}
                # Twice slow in a row: stop it and Start-LocalModel starts it again on the next pass.
                if($slowChecks -ge 2){
                    Add-Content (Join-Path $logs 'connection-health.log') ('{0:o} PC model at {1:N1} tok/s twice; restarting llama-server' -f [DateTime]::UtcNow,$speed)
                    Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
                    $slowChecks=0
                }
            }
        }
        @{tunnelPid=$tunnelProcess.Id;watcherPid=$PID} | ConvertTo-Json | Set-Content (Join-Path $logs 'runtime.json')
        if($Watch){Start-Sleep -Seconds 5}
    }while($Watch)
}catch{
    Add-Content (Join-Path $logs 'watcher-error.log') ('{0:o} {1}' -f [DateTime]::UtcNow,$_.Exception.ToString())
    throw
}finally{$watchMutex.ReleaseMutex();$watchMutex.Dispose()}
