import urllib.request
import json
import os
import sys

prompt = """당신은 수능 생명과학 I 최고 권위 출제위원입니다.
제공된 [원본 문제 및 해설]을 바탕으로, 개념과 풀이 로직(흥분 전도 속도, 자극 지점 찾기, 막전위 매칭, 시냅스 위치 추론)을 유지하되 조건과 수치(지점 거리, 속도, 자극 지점, 측정 시간 t1, 막전위 표 값 등)를 창의적이고 과학적으로 엄밀하게 변형한 [새로운 수능형 변형 문제]를 만들어 주세요.

[원본 문제]
- 민말이집 신경 A와 B (지점 d1~d4 위치: 각각 0cm, 2cm, 5cm, 7cm). B는 2개의 뉴런으로 구성되어 있고, ㉠~㉢ 중 한 곳에만 시냅스가 있음.
- d3에 동시 자극 후 t1 경과 시점 막전위 표 (I~IV는 d1~d4 무순):
  A: I(-80mV), II(0mV[재분극]), III(?), IV(-70mV)
  B: I(0mV), II(-60mV), III(?), IV(-70mV)
- B의 두 뉴런 흥분 전도 속도: 1cm/ms로 동일.
- 활동 전위 막전위 변화: 자극 0ms -> 1ms(-60mV), 2ms(+30mV), 2.5ms(0mV[재분극]), 3ms(-80mV), 4ms(-70mV).
- 보기: ㄱ. t1은 5ms이다(오답, 4ms). ㄴ. 시냅스는 ㉢에 있다(정답). ㄷ. t1일 때 A의 II에서 탈분극(오답, 재분극).
- 정답: ② (ㄴ)

반드시 아래 JSON 형식으로만 응답하세요:
{
  "model": "Gemma 4 12B",
  "title": "문제 제목",
  "body": "새 변형 문제 본문 (조건, 지점 위치, 표 등 마크다운 형식으로 상세히)",
  "choices": ["보기①", "보기②", "보기③", "보기④", "보기⑤"],
  "answer": "정답 번호 및 내용",
  "explanation": "단계별 상세 해설 (Step 1 지점 매칭, Step 2 흥분 전도 속도 계산, Step 3 t1 및 시냅스 위치 추론, 보기 분석)",
  "changeSummary": "원본 문제 대비 변형된 핵심 요소 및 출제 의도"
}
"""

def generate_gemma():
    print(">>> 1. Generating with Gemma 4 12B (local)...")
    url = "http://127.0.0.1:8092/v1/chat/completions"
    payload = {
        "model": "edumaster-gemma-4-12b-vision",
        "messages": [
            {"role": "system", "content": "You are a professional Life Science exam author. Output valid JSON only."},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.2,
        "max_tokens": 4096
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        content = res["choices"][0]["message"]["content"]
        with open("artifacts/gemma_result_raw.txt", "w", encoding="utf-8") as f:
            f.write(content)
        print("Gemma finished! Output length:", len(content))
        return content

def generate_deepseek():
    print(">>> 2. Generating with DeepSeek...")
    with open("artifacts/web/deepseek-api-key.txt", "r", encoding="utf-8") as f:
        key = f.read().strip()
    url = "https://api.deepseek.com/chat/completions"
    payload = {
        "model": "deepseek-flash",
        "messages": [
            {"role": "system", "content": "You are a professional Life Science exam author. Output valid JSON only."},
            {"role": "user", "content": prompt.replace("Gemma 4 12B", "DeepSeek")}
        ],
        "temperature": 0.2,
        "max_tokens": 4096,
        "response_format": {"type": "json_object"}
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}"
    })
    with urllib.request.urlopen(req, timeout=120) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        content = res["choices"][0]["message"]["content"]
        with open("artifacts/deepseek_result_raw.txt", "w", encoding="utf-8") as f:
            f.write(content)
        print("DeepSeek finished! Output length:", len(content))
        return content

def generate_gemini():
    print(">>> 3. Generating with Gemini API (gemini-2.5-flash / gemini-3.8-flash)...")
    with open("artifacts/web/gemini-api-key.txt", "r", encoding="utf-8") as f:
        key = f.read().strip()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}"
    payload = {
        "contents": [
            {"role": "user", "parts": [{"text": prompt.replace("Gemma 4 12B", "Gemini 3.8 Flash")}]}
        ],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 4096,
            "responseMimeType": "application/json"
        }
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        candidate = res["candidates"][0]
        content = "".join(part["text"] for part in candidate["content"]["parts"] if "text" in part)
        with open("artifacts/gemini_result_raw.txt", "w", encoding="utf-8") as f:
            f.write(content)
        print("Gemini API finished! Output length:", len(content))
        return content

if __name__ == "__main__":
    os.makedirs("artifacts", exist_ok=True)
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    if mode in ("all", "gemma"):
        try: generate_gemma()
        except Exception as e: print("Gemma exception:", e)
    if mode in ("all", "deepseek"):
        try: generate_deepseek()
        except Exception as e: print("DeepSeek exception:", e)
    if mode in ("all", "gemini"):
        try: generate_gemini()
        except Exception as e: print("Gemini exception:", e)
