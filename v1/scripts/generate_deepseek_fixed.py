import urllib.request
import json

prompt = """당신은 수능 생명과학 I 최고 권위 출제위원입니다.
제공된 [원본 문제 및 해설]을 바탕으로, 개념과 풀이 로직(흥분 전도 속도, 자극 지점 찾기, 막전위 매칭, 시냅스 위치 추론)을 유지하되 조건과 수치(지점 거리, 속도, 자극 지점, 측정 시간 t1, 막전위 표 값 등)를 창의적이고 과학적으로 엄밀하게 변형한 [새로운 수능형 변형 문제]를 만들어 주세요.

[원본 문제 분석]
- 민말이집 신경 A와 B(지점 d1~d4, 위치: 0cm, 2cm, 5cm, 7cm). B는 2개의 뉴런, ㉠~㉢ 중 한 곳에만 시냅스.
- d3에 동시 자극 후 t1 경과 시점 막전위 표 (I~IV는 d1~d4 무순):
  A: I(-80), II(0[재분극]), III(?), IV(-70)
  B: I(0), II(-60), III(?), IV(-70)
- B의 두 뉴런 흥분 전도 속도: 1cm/ms.
- 막전위 그래프: 0ms(-70), 1ms(-60), 2ms(+30), 2.5ms(0[재분극]), 3ms(-80), 4ms(-70).
- 보기: ㄱ. t1은 5ms이다(오답, 4ms). ㄴ. 시냅스는 ㉢에 있다(정답). ㄷ. t1일 때 A의 II에서 탈분극(오답, 재분극). 정답 ②(ㄴ)

[변형 가이드라인]
1. 원본의 핵심 추론 구조(자극 지점 판별 -> 막전위 매칭 -> 전도 속도 계산 -> 시냅스 위치 및 경과 시간 t1 결정)를 충실히 반영하되, 지점 위치(예: 0, 3, 6, 9cm 등), 속도(예: 2cm/ms 또는 3cm/ms), 자극 지점, 측정 시간 t1 등을 새롭게 재구성하세요.
2. 수치와 막전위 값, 전도 시간, 막전위 변화 시간의 합이 수학적·생물학적으로 완벽하게 맞아떨어지도록 검산하여 설계하세요.
3. 보기는 ㄱ, ㄴ, ㄷ 3개로 구성하고, 5지선다형(①~⑤)으로 작성하세요.

반드시 다음 JSON 형식으로만 응답하세요:
{
  "model": "DeepSeek",
  "title": "민말이집 신경 A와 B의 흥분 전도와 전달 (DeepSeek 변형)",
  "body": "새 변형 문제 본문 (조건, 지점 위치, 표 등 마크다운 형식)",
  "choices": ["① ...", "② ...", "③ ...", "④ ...", "⑤ ..."],
  "answer": "정답 번호 및 보기 (예: ② ㄴ)",
  "explanation": "단계별 상세 풀이 및 해설 (Step 1 지점 매칭, Step 2 흥분 전도 속도 계산, Step 3 t1 및 시냅스 위치 추론, 보기 분석)",
  "changeSummary": "원본 문제 대비 변형 포인트 및 출제 의도 요약"
}
"""

with open("artifacts/web/deepseek-api-key.txt", "r", encoding="utf-8") as f:
    key = f.read().strip()

url = "https://api.deepseek.com/chat/completions"
payload = {
    "model": "deepseek-flash",
    "messages": [
        {"role": "system", "content": "You are a professional Life Science exam writer. Output valid JSON only, without markdown fence."},
        {"role": "user", "content": prompt}
    ],
    "thinking": {"type": "disabled"},
    "max_tokens": 4096,
    "response_format": {"type": "json_object"}
}

req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={
    "Content-Type": "application/json",
    "Authorization": f"Bearer {key}"
})

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        content = res["choices"][0]["message"]["content"]
        with open("artifacts/deepseek_result.json", "w", encoding="utf-8") as f:
            f.write(content)
        print("DeepSeek generated successfully! Length:", len(content))
except Exception as e:
    print("Error:", e)
