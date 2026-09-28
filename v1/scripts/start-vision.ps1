$ErrorActionPreference='Stop'
$workspace=Split-Path $PSScriptRoot -Parent
$server='D:\work\dev\blog\windows\bin\llama-server.exe'
$model=Join-Path $workspace 'tools/models/ocr/Qwen3VL-4B-Instruct-Q4_K_M.gguf'
$projector=Join-Path $workspace 'tools/models/ocr/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf'
$logs=Join-Path $workspace 'artifacts/evidence/web'
$pidFile=Join-Path $logs 'vision-pid.txt'
$listener=Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if($listener){
    try{$models=Invoke-RestMethod -Uri 'http://127.0.0.1:8091/v1/models' -TimeoutSec 4}
    catch{throw '이미지 모델 포트가 사용 중이지만 모델 응답을 확인하지 못했습니다.'}
    if(-not @($models.data | ForEach-Object id | Where-Object {$_ -match 'edumaster-ocr-qwen3vl-4b|Qwen3VL-4B'}).Count){throw '이미지 모델 포트를 다른 모델이 사용 중입니다.'}
    return
}
foreach($path in @($server,$model,$projector)){if(-not(Test-Path -LiteralPath $path)){throw "이미지 모델 파일을 찾지 못했습니다: $path"}}
New-Item -ItemType Directory -Force $logs | Out-Null
if(Test-Path -LiteralPath $pidFile){
    $previousId=0
    if([int]::TryParse((Get-Content $pidFile -Raw).Trim(),[ref]$previousId)){
        $previous=Get-Process -Id $previousId -ErrorAction SilentlyContinue
        if($previous -and $previous.Path -eq $server){
            if(([DateTime]::Now - $previous.StartTime) -lt [TimeSpan]::FromMinutes(3)){return}
            Stop-Process -Id $previousId -ErrorAction Stop
        }
    }
}
$arguments=@('-m',$model,'--mmproj',$projector,'--host','127.0.0.1','--port','8091','--alias','edumaster-ocr-qwen3vl-4b','-c','8192','-np','1','-ngl','4','-b','1024','-ub','256','--image-max-tokens','2048')
$vision=Start-Process $server -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $logs 'vision-server.log') -RedirectStandardOutput (Join-Path $logs 'vision-out.log')
$vision.Id | Set-Content $pidFile
