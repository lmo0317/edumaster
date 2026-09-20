param([string]$BaseUrl='https://minohlee.mooo.com/edumaster/')
$ErrorActionPreference='Stop'
$workspace=Split-Path $PSScriptRoot -Parent
$access=(Get-Content (Join-Path $workspace 'artifacts/web/access-token.txt') -Raw).Trim()
$headers=@{Authorization='Bearer '+$access}
$evidence=Join-Path $workspace 'artifacts/evidence/web'
New-Item -ItemType Directory -Force $evidence | Out-Null
$checks=[Collections.Generic.List[string]]::new()
function Check($condition,$name){if(-not $condition){throw $name};$checks.Add('PASS: '+$name)}
for($attempt=0;$attempt -lt 10;$attempt++){
    try{$status=Invoke-RestMethod ($BaseUrl+'api/status') -Headers $headers -TimeoutSec 5;break}
    catch{if($attempt -eq 9){throw};Start-Sleep -Milliseconds 500}
}
Check ($status.ready -and $status.vision -and $status.model -eq 'Gemma 4 12B') 'public-local-gemma-connection'
$withoutAccess=Invoke-WebRequest ($BaseUrl+'api/status') -SkipHttpErrorCheck
Check ($withoutAccess.StatusCode -eq 401) 'anonymous-api-rejected'
$file=Join-Path $evidence 'own-problem.txt'
[IO.File]::WriteAllText($file,'탄산칼슘 10 g을 완전히 분해한다. CaCO₃ → CaO + CO₂, CaCO₃ = 100 g/mol일 때 발생하는 CO₂의 몰수는?')
$import=Invoke-RestMethod ($BaseUrl+'api/import') -Headers $headers -Method Post -Form @{file=Get-Item $file}
Check ($import.body.Contains('CaCO₃')) 'public-file-upload-text'
# Separately typeset fixture; this test does not validate the PDF original samples.
$image=Invoke-RestMethod ($BaseUrl+'api/import') -Headers $headers -Method Post -Form @{file=Get-Item (Join-Path $workspace 'docs/참고자료/샘플자료/07_반응량_고해상도예시.png')}
Check ($image.needsReview -and $image.body.Length -gt 100 -and $image.readMethod -eq '로컬 Qwen3-VL 이미지 인식') 'public-image-upload-ocr'
Check ((($image.body -replace '\s','').Contains('몰질량')) -and -not $image.body.Contains('물질량')) 'image-molar-mass-read-correctly'
$compact=$image.body -replace '\s',''
Check ($compact.Contains('A(g)+bB(g)→2C(g)+2D(g)') -and $compact.Contains('Bw') -and $compact.Contains('5w') -and $compact.Contains('6w') -and $compact.Contains('7w') -and $compact.Contains('10/3') -and $compact.Contains('전체기체') -and $compact.Contains('18') -and $compact.Contains('20')) 'image-equation-table-and-fraction-read'
$image|ConvertTo-Json -Depth 4|Set-Content (Join-Path $evidence 'verified-image-import.json') -Encoding utf8
Check ((Get-ChildItem (Join-Path $workspace 'artifacts/web/uploads') -Directory).Count -eq 0) 'uploaded-files-removed-after-import'
$invalid=Join-Path $evidence 'unsupported.exe';[IO.File]::WriteAllText($invalid,'test-only fixture')
$invalidResponse=Invoke-WebRequest ($BaseUrl+'api/import') -Headers $headers -Method Post -Form @{file=Get-Item $invalid} -SkipHttpErrorCheck
Check ($invalidResponse.StatusCode -eq 400) 'unsupported-file-rejected'
$payload=@{title=$image.title;body=$image.body;answer='';explanation='';sourceId=$image.sourceId;requiresImage=$true}|ConvertTo-Json -Compress
$started=Invoke-RestMethod ($BaseUrl+'api/generate') -Headers $headers -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload))
$deadline=(Get-Date).AddSeconds(310)
do{Start-Sleep -Milliseconds 700;$job=Invoke-RestMethod ($BaseUrl+'api/jobs/'+$started.id) -Headers $headers;if((Get-Date) -gt $deadline){throw 'generation-timeout'}}while($job.state -eq 'running')
Check ($job.state -eq 'ready' -and $job.result.model -eq 'Gemma 4 12B' -and $job.result.choices.Count -eq 5) 'public-upload-to-actual-gemma-result'
Check ($job.result.runtimeModelId -like '*gemma-4-12b*') 'actual-runtime-model-recorded'
$job.result|ConvertTo-Json -Depth 8|Set-Content (Join-Path $evidence 'verified-image-generation.json') -Encoding utf8
Check ((($job.result.sourceProblem -replace '\s','').Contains('몰질량')) -and (($job.result.body -replace '\s','').Contains('몰질량'))) 'image-question-concept-preserved'
Check ($job.result.answer.Contains('2/5')) 'reaction-example-answer-preserved-under-uniform-mass-scale'
Check ($job.result.generationNotice.Contains('계산 검증')) 'reaction-quantity-check-applied'
$variant=($job.result.body -replace '\s','') -replace '[()]',''
Check ($variant.Contains('10w') -and $variant.Contains('12w') -and $variant.Contains('14w') -and $variant.Contains('20/3') -and $variant.Contains('B2w')) 'all-three-mass-rows-doubled-consistently'
Check ($image.sourceId -and $job.result.visualContexts.Count -eq 1 -and $job.result.visualVerification.Contains('대조')) 'original-image-understanding-and-verification'
$expired=Invoke-WebRequest ($BaseUrl+'api/generate') -Headers $headers -Method Post -ContentType 'application/json' -Body '{"title":"test","body":"test body","requiresImage":true,"sourceId":"missing"}' -SkipHttpErrorCheck
Check ($expired.StatusCode -eq 400) 'missing-original-never-falls-back-to-text'
Check ($job.result.imageInputCount -eq 1 -and $job.result.runtimeModelId -eq 'edumaster-gemma-4-12b-vision' -and $job.result.visualVerification.Contains('직접 입력')) 'original-image-directly-sent-to-gemma-vision'
$checks|ConvertTo-Json|Set-Content (Join-Path $evidence 'web-smoke.json') -Encoding utf8
$checks
