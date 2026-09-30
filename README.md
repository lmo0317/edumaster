# EduMaster

교사가 준 문제(필수)와 해설(선택)을 읽고, **그 해설의 풀이 로직을 그대로 쓰는** 단계별 변형 문제를 만든다.
STEP 1 연습 → STEP 1~2 누적 → … → 최종 쌍둥이(수치 변형 또는 앞 문제 아이디어를 엮은 통합 변형).

서버: https://minohlee.mooo.com/edumaster/ (접속 코드는 서버 `data/access-code.txt`). 모델 비교 공개 페이지: https://minohlee.mooo.com/edumaster/compare.html

## 설계

2026-09까지의 .NET 버전(git 기록의 `v1/`, 2026-09-30 삭제)은 세 가지 문제가 있었다.

1. **범용성 부족** — 반복 실패를 막으려고 특정 3 STEP 반응량 문제를 코드 템플릿으로 고정했다. 다른 유형·다른 STEP 수에는 적용되지 않았다.
2. **피드백이 실제로 반영되지 않음** — 저장된 지침은 `teacher`/`beginner` 두 스타일로만 분류됐고, 앞 연습 문제 내용은 최종 문제 설계에 전달되지 않았다.
3. **검토 루프의 비용** — AI 검토자의 오판 → 전체 재생성 반복으로 토큰을 크게 썼다.

지금 버전의 설계:

| 문제 | 방식 |
|---|---|
| 유형별 계산기/템플릿 필요 | 생성 모델이 문제와 함께 **검산 프로그램**(mathjs 식 목록)을 쓰고, 서버가 이를 **정확한 분수**로 실행해 정답·선택지 중복·조건(가정의 모순 등)을 확인한다. 유형별 코드가 필요 없다. 문자 선택지(m/n 등)는 여러 값을 대입해 서로 다른지도 본다. |
| AI 검토자가 풀이를 오판 | 검토자는 해설을 평가하지 않고, **정답을 모른 채 문제만 보고 다시 푼다**. 정답 번호와 필요했던 STEP이 맞는지만 대조한다. |
| 재생성 반복으로 토큰 낭비 | 불일치가 있으면 **수정은 한 번만**. 그래도 남으면 이유와 함께 "교사 검토 필요"로 보여 준다. 작업마다 호출 수·토큰 상한이 있다. |
| 필기가 문제 조건에 섞임 | 분석 단계에서 필기·표시를 `annotations`로 분리해 보여 주고, 교사가 분석 결과(문제·STEP)를 직접 고칠 수 있다. 고친 내용이 생성 기준이다. |
| STEP 수 고정 | STEP 개수는 원본 해설에서 온다. 만들 문제 목록(누적/집중/쌍둥이)도 그 개수로 만든다. |
| 앞 문제 아이디어 미통합 | 문제를 순서대로 만들고, 뒤 문제에 **앞에서 실제로 만든 문제 내용**을 넘긴다. 통합 변형은 이를 엮도록 지시한다. |
| 피드백이 라벨뿐 | 승인된 지침/피드백을 매 생성 지시문에 붙이고, 결과마다 **각 지침을 어떻게 지켰는지(생성 모델 자기 보고)**와 **독립 검토 판정**을 보여 준다. 문제 하나만 피드백으로 다시 만들 수 있고, 이전 버전은 남는다. |

"학습"은 프롬프트에 지침을 붙이는 방식(검색 + 첨부)이다. 모델 가중치 학습이 아니다.

## 구조

```
server/
  index.js        HTTP 서버 (정적 파일 + JSON API, 접속 코드 → 쿠키 세션)
  config.js       환경 변수 / 작업별 호출·토큰 상한
  store.js        JSON 파일 저장소 (data/)
  llm.js          DeepSeek 호출, 사용량 기록, 예산
  prompts.js      모든 모델 지시문 (분석 / 설계 / 독립 풀이 / 수정)
  pipeline.js     분석 → 문제별 설계 → 코드 검산 + 독립 풀이 → (1회) 수정
  verify/         검산 프로그램 실행기 (worker thread, 4초·메모리 제한, 위험 함수 차단)
  learning.js     지침/피드백 저장·승인·유사 문제 선택
  plan.js         만들 문제 단계 구성
  jobs.js         백그라운드 작업 (디스크 저장, 취소, 재시작 후 이어하기)
  mock-llm.js     유료 호출 없는 개발용 모의 모델
public/           웹 화면 (index.html + app.js), 학습지/PDF(report.html), KaTeX 수식
test/             node:test (검산기, 모의 모델 전체 흐름, 예산 상한)
eval/             하네스 (cases/, run.js, 채점, 보고서, 모델 비교 자료)
deploy/           systemd 서비스, nginx 설정 스크립트, 배포 스크립트, SSH 터널 가드
scripts/          dev-mock.js (로컬 모의 실행), e2e-real.js (실제 모델 시험 — 유료),
                  start-web.ps1 / start-local-model.ps1 (PC 로컬 모델 + 서버 터널)
```

## 실행

```bash
npm install
npm test                     # 유료 호출 없음
node scripts/dev-mock.js     # http://127.0.0.1:18390, 접속 코드 dev, 모의 모델
```

실제 모델: `data/deepseek-api-key.txt`에 키를 두고 `node server/index.js` (기본 127.0.0.1:18290).

## 배포 (112 서버)

```bash
bash deploy/deploy.sh        # Git Bash에서. 서버 data/는 보존
```

- 서버 경로 `~/apps/edumaster`, 사용자 서비스 `edumaster`, 포트 127.0.0.1:18290
- DeepSeek 키와 접속 코드는 서버 `data/`에 있다 (저장소에 넣지 않는다).
- nginx 경로 설정은 sudo가 필요하다: `sudo bash ~/apps/edumaster/deploy/nginx-edumaster.sh` — `/edumaster/`를 이 서버로, 예전 주소 `/edumasterv2/…`·`/edumasterv1/…`는 `/edumaster/…`로 넘긴다.

## PC 로컬 모델

무료 "PC 모델"은 교사 PC의 llama-server(포트 8092)이고, SSH 역터널로 서버 18283에 연결된다.

- `scripts/start-web.ps1 -Watch` — 작업 스케줄러 "EduMaster Web Watcher"가 로그온 때 실행. 모델이 꺼져 있으면 `scripts/local-model.txt`의 모델을 띄우고, 터널을 유지한다 (서버 쪽 `deploy/tunnel-guard.py`).
- 모델 바꾸기: `pwsh scripts/start-local-model.ps1 -Name qwen36|gemma26|gemma12|…` (기본 qwen36). 모델 파일은 `tools/models/local-candidates/` (저장소 밖, gitignore).
- 로그: `logs/`

## 한계 (숨기지 않음)

- 그림이 꼭 필요한 문제는 그림을 글/표로 설명한다. 그림 자동 생성은 없다.
- ㄱㄴㄷ 선지처럼 수치가 아닌 문제는 코드 검산 대상이 아니고 독립 풀이 대조에 의존한다.
- 독립 풀이도 모델이다. "검증 통과"는 교사 최종 승인과 같지 않다.
- 해설 관련 지침의 준수 여부는 생성 모델의 자기 보고다 (독립 검토는 문제 관련 지침만 판정).
- PC 모델(Qwen 3.6-35B)은 무료지만 느리고 품질이 DeepSeek·Claude보다 낮다 (모델 비교 페이지 참고).
- PDF는 브라우저 인쇄(PDF로 저장)로 만든다.
