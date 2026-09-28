import urllib.request
import json
import os

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
1. 원본의 복잡한 추론 논리(자극 지점 판별 -> 막전위 매칭 -> 전도 속도 계산 -> 시냅스 위치 및 경과 시간 t1 결정)를 철저히 계승하되, 새로운 거리/속도/지점 값으로 정합성 있는 문제를 설계하세요.
2. 수치와 계산이 수학적·생물학적으로 100% 모순 없이 완벽하게 맞아떨어져야 합니다.
3. 보기는 ㄱ, ㄴ, ㄷ 3개로 구성하고, 5지선다형(①~⑤)으로 만드세요.

반드시 다음 JSON 형식으로만 출력하세요 (마크다운 백틱 없이 순수 JSON):
{
  "model": "모델명",
  "title": "문제 제목",
  "body": "새 변형 문제 본문 (조건, 지점 위치, 표 등)",
  "choices": ["① ...", "② ...", "③ ...", "④ ...", "⑤ ..."],
  "answer": "정답 번호 (예: ② ㄴ)",
  "explanation": "단계별 상세 풀이 및 해설 (Step 1 지점 매칭, Step 2 흥분 전도 속도 계산, Step 3 t1 및 시냅스 위치 추론, 보기 분석)",
  "changeSummary": "원본 문제 대비 변형 포인트 및 출제 의도 요약"
}
"""

def run_deepseek():
    print("Generating DeepSeek variant...")
    with open("artifacts/web/deepseek-api-key.txt", "r", encoding="utf-8") as f:
        key = f.read().strip()
    url = "https://api.deepseek.com/chat/completions"
    payload = {
        "model": "deepseek-flash",
        "messages": [
            {"role": "system", "content": "You are a professional Life Science exam writer. Output valid JSON only, without any markdown formatting."},
            {"role": "user", "content": prompt.replace("모델명", "DeepSeek")}
        ],
        "temperature": 0.2,
        "max_tokens": 8192,
        "response_format": {"type": "json_object"}
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}"
    })
    with urllib.request.urlopen(req, timeout=120) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        msg = res["choices"][0]["message"]
        content = msg.get("content", "")
        print("DeepSeek finished. Tokens used:", res.get("usage"))
        with open("artifacts/deepseek_result.json", "w", encoding="utf-8") as f:
            f.write(content)
        return content

def run_gemini():
    print("Generating Gemini 3.8 Flash variant...")
    with open("artifacts/web/gemini-api-key.txt", "r", encoding="utf-8") as f:
        key = f.read().strip()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}"
    payload = {
        "contents": [
            {"role": "user", "parts": [{"text": prompt.replace("모델명", "Gemini 3.8 Flash")}]}
        ],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json"
        }
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        candidate = res["candidates"][0]
        content = "".join(part["text"] for part in candidate["content"]["parts"] if "text" in part)
        print("Gemini API finished. Finish reason:", candidate.get("finishReason"))
        with open("artifacts/gemini_result.json", "w", encoding="utf-8") as f:
            f.write(content)
        return content

if __name__ == "__main__":
    run_deepseek()
    run_gemini()
