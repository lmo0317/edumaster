$ErrorActionPreference='Stop'
# Called by the watcher (start-web.ps1) on every pass: keeps the PC model for v2 running on port 8092.
# Which model: local-model.txt next to this script (qwen36 / gemma26 / gemma12), see start-local-model.ps1.
# A model started by hand with start-local-model.ps1 is left alone, so switching models needs no watcher restart.
$workspace=Split-Path $PSScriptRoot -Parent
$logs=Join-Path $workspace 'artifacts/evidence/web'
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
    New-Item -ItemType Directory -Force $logs | Out-Null
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
