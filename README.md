# EduMaster

교사가 준 킬러 문제와 풀이 방법을 이해해서, 그 풀이 로직을 단계적으로 연습시키는 변형 문제(STEP 1 연습 → STEP 1~2 누적 → … → 최종 쌍둥이)를 만드는 프로그램.

이 저장소에는 두 버전이 있다.

| 폴더 | 내용 | 서버 주소 |
|---|---|---|
| [`v1/`](v1/) | 2026-09까지 작업한 .NET(Core/Web/WPF) 버전 전체. 문서·샘플·스크립트·증거 자료 포함. 인수인계 문서: [`v1/CLAUDE_인수인계_전체작업_2026-09-28.md`](v1/CLAUDE_인수인계_전체작업_2026-09-28.md) | https://minohlee.mooo.com/edumasterv1/ (기존 `/edumaster/`도 그대로 v1) |
| [`v2/`](v2/) | 인수인계 내용을 바탕으로 처음부터 다시 만든 Node.js 버전 | https://minohlee.mooo.com/edumasterv2/ |

v1의 로컬 실행/배포 스크립트는 경로를 스크립트 위치 기준으로 계산하므로 `v1/scripts/…`에서 그대로 실행하면 된다 (예: `v1/scripts/start-web.ps1 -Watch`). 스크립트나 문서 안에 `D:\work\dev\edumaster\src\…`처럼 절대 경로가 적힌 옛 자료는 `v1\` 아래로 읽으면 된다.

v2 설명은 [`v2/README.md`](v2/README.md).
