# Starts one local vision model for EduMaster on port 8092 (the SSH tunnel maps it to the server's 18283).
#   pwsh start-local-model.ps1 -Name qwen36      # Qwen 3.6-35B-A3B (MoE)
#   pwsh start-local-model.ps1 -Name qwen38      # Qwen 3.8-27B (dense, 3-bit so it fits the GPU)
#   pwsh start-local-model.ps1 -Name qwen38q4    # Qwen 3.8-27B (dense, 4-bit, spills a little to the CPU)
#   pwsh start-local-model.ps1 -Name qwen38gsq   # Qwen 3.8-27B, ISTA-DASLab GSQ-RCO 3.5-bit (near-BF16 accuracy, wholly on the GPU)
#   pwsh start-local-model.ps1 -Name ornith      # Ornith-1.5-35B-A3B (Qwen 3.6 MoE, further trained)
#   pwsh start-local-model.ps1 -Name gemma26     # Gemma 4 26B-A4B (MoE)
#   pwsh start-local-model.ps1 -Name gemma12     # Gemma 4 12B (previous default)
# Thinking stays available (--reasoning auto); the server turns it on per request for design calls.
# Model files: tools/models/ (not in git). The watcher (start-web.ps1) starts the name in local-model.txt.
param([ValidateSet('qwen36', 'qwen38', 'qwen38q4', 'qwen38gsq', 'ornith', 'gemma26', 'gemma12')][string]$Name = 'qwen36', [int]$Ctx = 49152, [switch]$NoWait)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$server = 'D:\work\dev\blog\windows\bin\llama-server.exe'
$cand = Join-Path $workspace 'tools/models/local-candidates'
$logs = Join-Path $workspace 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
# --fit-target: VRAM kept free. With it full, image prefill fell into shared memory (228s instead of 8s per image).
$qwenImage = @('--image-min-tokens', '1024', '--image-max-tokens', '4096')
$models = @{
  qwen36   = @{ m = Join-Path $cand 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf'; p = Join-Path $cand 'mmproj-F16.gguf'; alias = 'edumaster-qwen3.6-35b-a3b'; extra = @('--fit', 'on', '--fit-target', '3072') + $qwenImage }
  # A dense model must sit wholly on the GPU (--fit moved layers to the CPU: 9 tok/s instead of 55); the 8-bit KV
  # cache leaves room for image prefill (47s per image with f16 KV, 2s with q8).
  qwen38   = @{ m = Join-Path $cand 'qwen38/Qwen3.8-27B-UD-Q3_K_XL.gguf'; p = Join-Path $cand 'qwen38/mmproj-F16.gguf'; alias = 'edumaster-qwen3.8-27b'; extra = @('--fit', 'off', '-ngl', '99', '-ctk', 'q8_0', '-ctv', 'q8_0') + $qwenImage }
  qwen38q4 = @{ m = Join-Path $cand 'qwen38/Qwen3.8-27B-UD-IQ4_XS.gguf'; p = Join-Path $cand 'qwen38/mmproj-F16.gguf'; alias = 'edumaster-qwen3.8-27b-q4'; extra = @('--fit', 'on', '--fit-target', '2048') + $qwenImage }
  # GSQ-RCO picks a quantization per tensor: 11.8 GB at 3.5 bits/weight, scored like BF16 on its card (2026-10-04).
  qwen38gsq = @{ m = Join-Path $cand 'qwen38gsq/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf'; p = Join-Path $cand 'qwen38gsq/mmproj-Qwen3.8-27B-BF16.gguf'; alias = 'edumaster-qwen3.8-27b-gsq'; extra = @('--fit', 'off', '-ngl', '99', '-ctk', 'q8_0', '-ctv', 'q8_0') + $qwenImage }
  ornith   = @{ m = Join-Path $cand 'ornith/Ornith-1.5-35B-Q4_K_M.gguf'; p = Join-Path $cand 'ornith/mmproj-Ornith-1.5-35B-BF16.gguf'; alias = 'edumaster-ornith-1.5-35b-a3b'; extra = @('--fit', 'on', '--fit-target', '3072') + $qwenImage }
  gemma26  = @{ m = Join-Path $cand 'gemma-4-26B_q4_0-it.gguf'; p = Join-Path $cand 'gemma-4-26B-it-mmproj.gguf'; alias = 'edumaster-gemma-4-26b-a4b'; extra = @('--fit', 'on', '--fit-target', '3072', '--image-min-tokens', '1120', '--image-max-tokens', '1120') }
  gemma12  = @{ m = 'D:\work\dev\blog\windows\.models\gemma-4-12b-it-qat-q4_0.gguf'; p = Join-Path $workspace 'tools/models/gemma-vision/mmproj-gemma-4-12B-it-BF16.gguf'; alias = 'edumaster-gemma-4-12b-vision'; extra = @('-ngl', '99', '--image-min-tokens', '1120', '--image-max-tokens', '1120') }
}
$c = $models[$Name]
foreach ($f in @($server, $c.m, $c.p)) { if (-not (Test-Path -LiteralPath $f)) { throw "없는 파일: $f" } }
# The watcher (start-web.ps1) takes the same lock, so it cannot start its own model in the moment
# between stopping the old one and starting this one. Re-entrant when the watcher itself calls this script.
$mutex = [Threading.Mutex]::new($false, 'Local\EduMasterGemmaVisionStarter')
[void]$mutex.WaitOne()
try {
  # Whatever holds the port is replaced.
  $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8092 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { Stop-Process -Id $listener.OwningProcess -Force; Start-Sleep -Seconds 2 }
  # -ub 2048: image prefill is non-causal and must fit one ubatch. --no-warmup: the multimodal warmup slowed
  # text generation ~10x in this llama.cpp build.
  $arguments = @('-m', $c.m, '--mmproj', $c.p, '--host', '127.0.0.1', '--port', '8092', '--alias', $c.alias, '-c', "$Ctx", '-fa', 'on', '-np', '1',
    '-b', '2048', '-ub', '2048', '--no-warmup', '--jinja', '--reasoning', 'auto', '--reasoning-budget', '-1') + $c.extra
  $p = Start-Process $server -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $logs "local-$Name.log") -RedirectStandardOutput (Join-Path $logs "local-$Name-out.log")
  $p.Id | Set-Content (Join-Path $logs 'local-model-pid.txt')
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
if ($NoWait) { exit 0 }
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 2
  try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8092/v1/models' -TimeoutSec 3; if ($r.data) { "ready $($c.alias) pid $($p.Id)"; exit 0 } } catch {}
  if ($p.HasExited) { throw "llama-server가 종료됨 — $(Join-Path $logs "local-$Name.log") 확인" }
}
throw '4분 안에 준비되지 않음'
