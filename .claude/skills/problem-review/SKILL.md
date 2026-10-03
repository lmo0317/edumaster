---
name: problem-review
description: EduMaster 문제 검수 — 선생님이 준 문제(또는 세트) 링크의 분석 결과와 변형 세트를 Claude와 Gemini(agy)가 서버에서 각각 독립적으로 풀어 보고 검토한 뒤, 두 검토를 대조해 한국어 리포트로 정리한다. "이 문제 검수해", "검수 스킬", 문제 링크(minohlee.mooo.com/edumaster/#/m/… 또는 #/j/…)와 함께 검토를 요청할 때 쓴다.
---

# 문제 검수 (Claude + Gemini)

선생님이 링크를 주면, 그 문제의 **분석 결과**(원본 옮겨 적기, STEP 정리)와 **변형 세트**(연습 문제, 최종 문제, 해설)를
Claude와 Gemini가 원본 이미지와 대조해 각자 직접 풀어 보고 검토한다. 두 모델은 하네스의 판정을 보지 않는다.
검토는 서버에서 앱과 같은 구독 연결(Claude Code CLI, agy)로 돌린다: `scripts/review-problem.js`.

## 1. 링크에서 id 찾기

- `…/edumaster/#/m/<24자리 hex>` → 문제 id. 그 문제의 **가장 최근 세트**를 검토한다.
- `…/edumaster/#/j/<id>` → 세트 id. **그 세트**를 검토한다.
- id만 준 경우도 그대로 쓴다. 링크에 id가 없으면 어떤 문제인지 묻는다.

## 2. 서버에서 실행

서버: `lmo0317@192.168.219.112`, 앱 폴더 `~/apps/edumaster`.

1. 서버의 스크립트가 로컬과 같은지 확인하고, 다르면 그 파일만 올린다 (서비스 재시작 필요 없음):
   ```bash
   md5sum scripts/review-problem.js; ssh lmo0317@192.168.219.112 "md5sum ~/apps/edumaster/scripts/review-problem.js"
   scp scripts/review-problem.js lmo0317@192.168.219.112:apps/edumaster/scripts/
   ```
2. 백그라운드로 시작한다 (Gemini는 3~5분, Claude는 2~5분 걸린다. ssh가 붙잡히지 않게 `setsid -f`):
   ```bash
   ssh lmo0317@192.168.219.112 "cd ~/apps/edumaster && setsid -f bash -c 'node scripts/review-problem.js <id> /tmp/review-<id>.json > /tmp/review-<id>.log 2>&1' </dev/null >/dev/null 2>&1"
   ```
   다른 모델 조합이 필요하면 `--providers claude-cli,agy-cli,codex-cli`처럼 준다 (기본은 claude-cli,agy-cli).
3. 끝날 때까지 기다린다. 결과 파일의 `"done": true`를 30초 간격으로, 최대 15분 확인한다 (Bash `run_in_background`의 until 루프나 Monitor):
   ```bash
   until ssh lmo0317@192.168.219.112 "grep -q '\"done\": true' /tmp/review-<id>.json"; do sleep 30; done
   ```
   기다리는 동안 선생님에게 시작했다고 한 줄 알린다.
4. 결과를 읽는다: `ssh lmo0317@192.168.219.112 "cat /tmp/review-<id>.json"`.
   - `material`: 원본 옮겨 적기, 정답, STEP(제목, 풀이)
   - `set.items[]`: 각 문제의 목표 범위, 문제, 선택지, 표시된 정답, 해설 STEP
   - `reviews["claude-cli" | "agy-cli"]`: `review`(analysis, items, summary), `usage`, `seconds`, 실패하면 `error`
   - 한 모델이 실패하면(연결 끊김, 한도) 그 사실을 리포트에 적고, 남은 모델의 검토로 정리한다. 한도 때문이면 다시 돌리지 않는다.

## 3. 대조하고 판단하기

모델의 지적을 그대로 옮기지 않는다. 지적마다 결과 파일의 문제·해설 원문을 직접 확인해 판단한다.
- **정답**: 두 모델의 `answerOk`와 `myAnswer`. 하나라도 정답이 다르다고 하면 직접 풀어서 누가 맞는지 가린다 — 가장 먼저 보고할 것.
- **지적 분류**:
  - 두 모델 모두 지적 → 거의 확실. 원문으로 확인.
  - 한 모델만 지적 → 원문으로 확인해 맞는지 판정한다. 틀린 지적이면 "지적이 틀림"으로 이유와 함께 적는다.
  - 표현 취향, 하네스가 의도한 차이(연습 문제의 목표 STEP만 쓰는 구조, 최종 문제의 다른 구조)는 결함이 아니다.
- **고칠 곳 구분** (확인된 결함마다):
  - **시스템**(다음 세트에서도 또 생길 결함: 프롬프트, 하네스 검사, 분석 읽기) → 어느 파일의 무엇인지까지 짚는다.
  - **이 문제의 데이터**(이미 만든 분석·세트) → 선생님이 화면에서 고칠 방법(분석 결과 수정, 고칠 점, 다시 만들기).

## 4. 리포트 (한국어)

결론부터, 짧게:
1. 한 줄 결론: 정답이 모두 맞는지, 바로 쓸 수 있는 문제와 고쳐야 할 문제.
2. 문제별 표: `문제 | 표시된 정답 | Claude | Gemini | 판정(사용/수정/폐기)`.
3. 확인된 결함: 어디, 무엇, 누가 지적, 심각도, 고칠 곳(시스템 / 이 문제). 지적했지만 틀린 것은 따로 짧게.
4. 사용량: 모델마다 토큰과 걸린 시간 (`usage.total`, `seconds`).

시스템 결함이 있으면 고치자고 제안만 한다. 선생님이 고치라고 하면 그때 근본 원인을 고치고(임시 땜질 금지), 테스트를 붙이고,
작업 중인 세트가 없을 때(`/api/status`의 activeJobs=0) 배포한다.

## 하지 말 것

- 라이브 사이트에 관리자 비밀번호로 로그인하지 않는다. 데이터는 서버의 스크립트로만 읽는다.
- 토큰·키·비밀번호를 출력하거나 로그에 남기지 않는다.
- 검토 결과로 데이터나 학습을 자동으로 바꾸지 않는다.
- 같은 문제의 검수를 동시에 두 번 돌리지 않는다 (구독 한도).
