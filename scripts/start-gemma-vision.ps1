$ErrorActionPreference='Stop'
$workspace=Split-Path $PSScriptRoot -Parent
$server='D:\work\dev\blog\windows\bin\llama-server.exe'
$model='D:\work\dev\blog\windows\.models\gemma-4-12b-it-qat-q4_0.gguf'
$projector=Join-Path $workspace 'tools/models/gemma-vision/mmproj-gemma-4-12B-it-BF16.gguf'
$logs=Join-Path $workspace 'artifacts/evidence/web'
$pidFile=Join-Path $logs 'gemma-vision-pid.txt'
$mutex=[Threading.Mutex]::new($false,'Local\EduMasterGemmaVisionStarter')
if(-not $mutex.WaitOne(0)){return}
try {
    if(Test-Path -LiteralPath $pidFile){
        $previousId=0
        if([int]::TryParse((Get-Content $pidFile -Raw).Trim(),[ref]$previousId)){
            $previous=Get-CimInstance Win32_Process -Filter "ProcessId=$previousId"
            if($previous -and $previous.CommandLine -like '*edumaster-gemma-4-12b-vision*' -and $previous.CommandLine -like '*edumaster*'){return}
        }
    }
    $listener=Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8092 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if($listener){
        $existing=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        if($existing.CommandLine -notlike '*edumaster-gemma-4-12b-vision*'){throw 'Gemma 이미지 포트를 다른 프로그램이 사용 중입니다.'}
        return
    }
    foreach($path in @($server,$model,$projector)){if(-not(Test-Path -LiteralPath $path)){throw "Gemma 이미지 실행 파일이 없습니다: $path"}}
    New-Item -ItemType Directory -Force $logs | Out-Null
    # Keep the shared Blog text server. Limit this server's GPU layers to coexist on 16GB.
    # Gemma image prefill is non-causal; ubatch must cover the entire 1120-token image.
    $arguments=@('-m',$model,'--mmproj',$projector,'--host','127.0.0.1','--port','8092','--alias','edumaster-gemma-4-12b-vision','-c','32768','-fa','on','-np','1','-ngl','12','-b','2048','-ub','2048','--no-mmproj-offload','--image-min-tokens','1120','--image-max-tokens','1120','--jinja','--reasoning-budget','0','--reasoning','off')
    $vision=Start-Process $server -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $logs 'gemma-vision-server.log') -RedirectStandardOutput (Join-Path $logs 'gemma-vision-out.log')
    $vision.Id | Set-Content $pidFile
} finally {$mutex.ReleaseMutex();$mutex.Dispose()}
