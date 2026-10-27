# 전체 코드 리뷰 수정 — 2026-10-27 (안정성)

사용자의 요청("프로그램 전체 코드 리뷰해서 안정성 확보")에 따라 서버·파이프라인·하네스·학습·프런트엔드·스크립트·배포를 모두 읽고, 프로세스 종료·멈춤·데이터 손상·조용한 오판으로 이어지는 결함을 고친 기록이다. 문제 생성 품질(모델이 내는 문제의 정확성)이 아니라 시스템이 죽거나 멈추거나 잘못 저장하는 경로를 다뤘다.

## 프로세스가 종료되던 경로 (서버 전체가 죽고 진행 중인 세트가 모두 끊김)

| 결함 | 수정 |
|---|---|
| 이미지·PDF 응답 스트림이 헤더 전송 뒤 실패하면(`/api/files`, 비교 PDF) 'error' 이벤트에 리스너가 없어 uncaught exception | 스트림 오류 시 응답 종료 (`server/index.js`) |
| CLI 자식 프로세스(claude, agy, codex, 로그인 도구)가 실행에 실패하면 stdin에 쓴 프롬프트가 EPIPE를 내고 리스너가 없어 종료 | stdin 'error' 처리, 이미 끝난 로그인 도구에 코드를 쓰면 409 (`server/llm.js`, `server/cli-models.js`, `server/index.js`) |
| 최상위 `unhandledRejection` / `uncaughtException` 핸들러 없음 | 기록하고 계속 실행 (작업 상태는 모두 디스크에 있고, 각 작업은 스스로 실패를 보고함) |
| mock 모드에서 분석 지침 글에 "STEP을 20000개로"가 있으면 모의 모델이 STEP을 2만 번 나눠(제목이 누적되어 194 MB) 힙 한도로 종료 | 파이프라인과 같은 10개 상한 (`server/mock-llm.js`) |

## 서버가 멈추던 경로

| 결함 | 수정 |
|---|---|
| **문장 틀 정규식의 치명적 백트래킹**: `《물질1》 《질량1》 《물질2》 《질량2》`처럼 공백만 두고 이어지는 슬롯이 `(.+?)\s*(.+?)\s*…`가 되어, 틀에 맞지 않는 긴 줄(모델 해설의 한 줄, 선생님 해설의 한 줄) 하나에 n^k 단계 — 400자에 60초 초과, 이벤트 루프가 막혀 HTTP 서버 전체가 응답하지 않음 | 이어지는 슬롯은 하나로 합치고, 정규식 전에 고정 글자들이 순서대로 들어 있는지 먼저 확인하며, 600자 넘는 줄은 대상에서 뺀다 (슬롯 수 상한은 두지 않는다: 2026-10-26 실행의 실제 틀에는 슬롯 6개 이상이 흔하다). 틀별 정규식은 캐시 (`server/harness.js` `frameMatches`) |
| 취소된 작업이 그 뒤에도 새 HTTP 호출을 시작 | 호출 전 abort 확인 (`server/llm.js`) |
| SIGTERM을 무시하는 CLI 자식이 시간 초과·취소 뒤에도 남음 | 5초 뒤 SIGKILL |
| 검산 worker가 답 없이 종료되면 timer까지 대기 | 'exit' 처리 (`server/verify/index.js`) |
| 학습 반복이 검수 중 취소·실패하면 그 세트의 검수 기록이 재시작까지 "진행 중" | try/finally로 `running` 해제 (`server/jobs.js`) |

## 데이터 손상·손실

| 결함 | 수정 |
|---|---|
| `users.json`을 제자리에 덮어써서, 쓰는 중 읽은 쪽(서버 로그인·`scripts/user.js`)이 빈 목록으로 보고 다음 계정 추가에서 다른 계정이 모두 사라질 수 있음 | 임시 파일 + rename, 느린 scrypt 뒤에 목록을 다시 읽음 (`server/users.js`) |
| 삭제한 세트의 결함 기록(`data/faults`)이 제자리 쓰기 — 중간에 끊기면 복구 불가 | 임시 파일 + rename (`server/faults.js`) |
| 분석 교정(`applyFixes`)이 문자열 `replace`를 써서 모델의 교정문에 든 `$$`, `$&`, `$'`가 패턴으로 확장됨 — 수식이 조용히 손상되거나 `$` 짝 검사에서 엉뚱한 이유로 거부 | 함수 치환자 사용, 옛 레코드에 없는 필드도 문자열로 읽음 (`server/pipeline.js`) |
| `scripts/review-problem.js`가 서버가 같은 세트를 검수하는 중에 그 기록을 덮어씀 | 서버 검수가 진행 중이면 `data/reviews`에는 쓰지 않고 출력 파일에만 씀 |
| `eval/run.js`가 `materials/`의 저장소 임시 파일(`.tmp`)까지 JSON으로 읽어 crash하고, 보고서를 끝에만 써서 몇 시간의 유료 실행 결과를 전부 잃음; 없는 case 이름도 실행 뒤에야 실패 | `.json`만 읽고 실패를 참으며, case를 시작 전에 확인하고, 보고서를 case마다 씀 |
| `eval/recheck.js`, `rejudge.js`, `compare-bundle.js`의 제자리 쓰기(서버가 읽는 비교 번들 포함); `rejudge --data` 누락 시 현재 폴더에서 동작 | 임시 파일 + rename, 인수 확인 |

## 잘못된 판정·상태

| 결함 | 수정 |
|---|---|
| 세트 검수(`set-check`)가 저장된 정답을 `it.problem?.answer`로 읽었는데 그 자리는 문제 본문 문자열이어서 항상 undefined — 검수자가 스스로 푼 답이 저장된 정답과 다를 때 잡는 2026-10-26의 가드가 세트 검수에서는 한 번도 동작하지 않음 | `it.answer` (`server/set-check.js`) |
| 검수 항목(checks)이 비어 있는 검수가 체크리스트 모든 행에서 'ok'로 집계되어 100점 | 판정하지 않은 행은 'na' (`server/final-review.js`) |
| 수정(repair) 응답을 읽기 도구가 거부(422: 한 글자 문제, STEP 번호 중복)하면 쓸 수 있는 직전 버전이 있어도 문제 전체가 실패 | 수정만 잃고 직전 버전 유지 (`server/pipeline.js` `repairWith`) |
| 학습 반복이 모델이 돌려준 학습 id를 그대로 저장소 키로 조회 — 모델이 id를 망가뜨리면(`rule-3`, 빈 값) 세트를 만들고 검수까지 마친 뒤 라운드가 crash | 모델에게 보여 준 목록에서만 찾음 |
| 세트 완료 뒤 학습(`learnFromSet`)에서 난 예외가 다 만든 세트를 '실패'로 표시 | 기록만 하고 세트는 완료 |
| 틀 추출 응답의 모양이 다르면(steps가 객체, 항목이 null, frames가 문자열) 모든 STEP의 틀을 잃음 | 잘못된 항목만 버림 (`server/harness.js` `validateFrames`) |
| 제목 없는 heading 객체가 "[object Object]" 제목으로 STEP 제목을 덮어씀; 모델이 보고한 해설 STEP 수가 음수·거대 값 가능 | 타입 확인, 0~20으로 clamp |

## 요청 처리 (클라이언트 입력으로 500)

| 결함 | 수정 |
|---|---|
| JSON 본문이 객체가 아닐 때(`null`, 배열, 문자열) 모든 핸들러에서 TypeError → 500 | 400 (`readBody`) |
| `Origin: null` 헤더에서 `new URL()`이 throw → 500 | 403 |
| 학습 항목의 `text`·`subject`가 객체·배열이면 "[object Object]"로 저장; `source.jobId`/`materialId`에 임의 문자열(`"><img …>`)이 저장되어 페이지 링크에 그대로 들어감(CSP가 유일한 방어); 클라이언트가 `status: 'dormant'`, `source.from: 'auto'`, `faultKeys`를 지정해 선생님 항목이 시스템 학습으로 분류·수정·휴면 대상이 됨 | 문자열만 받고, id는 `isId` 검사, `from`은 페이지 종류만, `dormant`는 시스템만 (`server/learning.js`, `server/index.js`); 페이지도 링크의 id를 이스케이프 |
| 로그인 실패 기록 Map이 IP별로 영구 증가 | 10분 지난 항목 정리 |
| 기록에 `createdAt`이 없으면(손으로 고친 파일) 정렬에서 TypeError → 모든 분석·생성 실패 | 문자열로 비교 |

## 프런트엔드 (`public/app.js`, `report.js`)

- 조용히 멈추던 폴링 3곳: 분석 끝난 뒤 문제 페이지 재시작이 `route()`의 오류 처리 밖에서 실행되어 실패하면 빈 화면; 검수 페이지의 15초 갱신이 한 번 실패하면 영구 중단("저절로 바뀝니다"인데 바뀌지 않음); LLM 탭 로그인 대기 루프가 오류를 삼키고 중복 실행. → 각각 `route()`로 복귀, 실패 시 재무장(지수 백오프 + 연결 배너), try/catch와 단일 실행.
- 느린 응답이 돌아왔을 때 이미 이동한 다른 페이지를 덮어쓰던 뷰(문제 목록·문제·세트·검수·비교·계정·문제 추가) → 라우트 토큰 확인 뒤에만 그림.
- 요청이 거부되면(409 등) 비활성화된 채 남던 버튼(세트 만들기, Gemini 연결) → finally로 복구.
- 문제 추가 페이지의 붙여넣기 리스너가 방문마다 누적되어 이미지를 N번 디코드 → AbortController로 페이지 이동 시 해제. 확대 이미지의 Escape 리스너 누수 수정.
- 학습 탭의 체크박스·필터가 요청 실패 시 아무 말 없이 무반응 → 토스트.
- `api()`가 2xx에 JSON이 아닌 본문(네트워크 로그인 페이지)을 받으면 `null`을 돌려 호출자가 "Cannot read properties of null" → 연결 오류로 처리. `report.js`도 `res.ok`를 먼저 확인.

## 배포 (`deploy/deploy.sh`)

- `npm ci`가 실행 중인 서비스 아래서 돌아 그 사이 검산 worker가 mathjs를 못 찾고 KaTeX가 404 → 파일 교체 전에 서비스를 멈추고, 어떤 경우에도 `trap`으로 다시 시작.
- `--keep-newer-files`가 모든 파일에 걸려 서버에서 한 번 건드린 `package-lock.json`이 영원히 갱신되지 않고 `npm ci`가 "not in sync"로 실패 → `eval/reports`만 서버의 새 사본을 유지.

## 테스트 환경 결함

- API 테스트 3개가 mock 모드에서 `claude-cli` provider를 쓰는데, 서버가 이 머신의 실제 Claude 로그인 파일 존재 여부를 확인해 개발자 PC에서만 통과하고 새 체크아웃에서는 실패했다. mock 모드에서는 준비된 것으로 취급한다 (`server/llm.js` `claudeCliReady`).

## 검증

- `npm test`: 기존 244개 + 새 회귀 테스트 15개(`test/stability.test.js`) 모두 통과 (main의 2026-10-27 리뷰 커밋과 합친 뒤 292개 통과, 실패 0).
- 프런트엔드: `scripts/dev-mock.js`에 Playwright로 로그인 → 자료 생성 → 세트 생성 뒤 18개 라우트와 `report.html`을 열어 JS 오류 0건, 느린 페이지에서 이동했을 때 이전 페이지가 덮어쓰지 않음을 확인.
- 문장 틀 정규식: 수정 전 400자 줄에 60초 초과(강제 종료), 수정 후 같은 입력에 2초 미만(테스트에 포함).

## 고치지 않고 남긴 것 (권고)

- usage 장부가 호출당 파일 1개(`data/usage/`)여서 2만 건에서 `all()`이 약 170 ms — LLM 탭·사용량 API를 열 때마다 그만큼 이벤트 루프가 막힌다. 아직 저장 구조를 바꿀 정도는 아니지만 계속 늘면 월별 파일로 묶는 편이 좋다.
- `data/faults`와 `data/reviews`를 요청마다 전부 다시 읽고(`faults.index`), 학습 항목 쌍 비교(`learning-map.mergePairs`)가 O(n²)로 요청 경로에서 실행된다 — 항목이 수천 개가 되면 페이지 열기가 1~2초 걸릴 수 있다.
- nginx `proxy_read_timeout 120s`보다 길어질 수 있는 동기 호출 경로(`/api/claude-login/check`, `/api/cli-login/*/check`, `align-steps`): 구독 모델이 느리면 서버는 성공했는데 화면은 504를 본다.
- systemd 유닛에 `MemoryMax=`가 없다; 호스트 메모리 크기를 알아야 값을 정할 수 있어 두었다.
- 학습 항목의 `scope: 'topic'`(옛 값)을 지금도 받아 재시작 시 마이그레이션이 `global/lesson`으로 바꾼다 — 테스트가 의도적으로 쓰고 있어 그대로 두었다.
