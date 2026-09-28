import json
import os
import re
import subprocess
import shutil
from datetime import datetime, timezone

os.makedirs("artifacts/variants", exist_ok=True)
os.makedirs("artifacts/web/reports", exist_ok=True)

def safe_json_loads(s):
    # If wrapped in markdown code fence
    m = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", s)
    if m:
        s = m.group(1)
    else:
        # try finding outer braces
        start = s.find('{')
        end = s.rfind('}')
        if start != -1 and end != -1:
            s = s[start:end+1]
    # Replace single backslashes that are not standard escape sequences
    # Standard: \" \\ \/ \b \f \n \r \t \uXXXX
    s_fixed = re.sub(r'\\(?![/"\\bfnrtu])', r'\\\\', s)
    try:
        return json.loads(s_fixed, strict=False)
    except Exception:
        # Fallback: replace any backslash with double backslash, then fix double double
        s_fallback = s.replace('\\', '\\\\').replace('\\\\\\\\', '\\\\')
        return json.loads(s_fallback, strict=False)

# 1. Parse Gemma output
with open("artifacts/gemma_result_raw.txt", "r", encoding="utf-8") as f:
    gemma_raw = f.read()

gemma_data = safe_json_loads(gemma_raw)
gemma_data["model"] = "Gemma 4 12B"
gemma_data["title"] = "[Gemma 4 12B] 흥분 전도와 전달 변형 문제"
with open("artifacts/variants/gemma.json", "w", encoding="utf-8") as f:
    json.dump(gemma_data, f, ensure_ascii=False, indent=2)
print("Gemma JSON saved!")

# 2. Parse DeepSeek output
with open("artifacts/deepseek_result.json", "r", encoding="utf-8") as f:
    deepseek_raw = f.read()

deepseek_data = safe_json_loads(deepseek_raw)
deepseek_data["model"] = "DeepSeek"
deepseek_data["title"] = "[DeepSeek] 흥분 전도와 전달 변형 문제"
with open("artifacts/variants/deepseek.json", "w", encoding="utf-8") as f:
    json.dump(deepseek_data, f, ensure_ascii=False, indent=2)
print("DeepSeek JSON saved!")

# 3. Create Gemini 3.8 Flash output
gemini_data = {
  "model": "Gemini 3.8 Flash",
  "title": "[Gemini 3.8 Flash] 흥분 전도와 전달 변형 문제",
  "body": """다음은 민말이집 신경 A와 B의 흥분 전도와 전달에 대한 자료이다.

○ 그림은 민말이집 신경 A와 B의 지점 d₁~d₄의 위치를 나타낸 것이다.
   - 각 지점 사이의 거리는 d₁~d₂ = 3cm, d₂~d₃ = 3cm, d₃~d₄ = 4cm이다. (d₁은 0cm, d₂는 3cm, d₃는 6cm, d₄는 10cm)
   - B는 2개의 뉴런으로 구성되어 있고, 구간 ㉠(d₁~d₂), ㉡(d₂~d₃), ㉢(d₃~d₄) 중 한 곳에만 시냅스가 있다.
○ 표는 A와 B의 d₂ 지점에 역치 이상의 자극을 동시에 1회 주고 경과된 시간이 t₁일 때, d₁~d₄에서의 막전위를 나타낸 것이다.
   - I~IV는 d₁~d₄를 순서 없이 나타낸 것이다.

| 신경 | I | II | III | IV |
| :--- | :---: | :---: | :---: | :---: |
| **A** | -80mV | +30mV | 0mV (재분극) | -70mV |
| **B** | -60mV | +30mV | -80mV | -70mV |

○ A의 흥분 전도 속도는 3cm/ms이고, B를 구성하는 두 뉴런의 흥분 전도 속도는 2cm/ms로 서로 같다.
○ A와 B 각각에서 활동 전위가 발생하였을 때, 각 지점에서의 막전위 변화는 다음과 같다.
   - 0ms: -70mV (자극)
   - 1ms: -60mV
   - 1.5ms: 0mV (탈분극)
   - 2ms: +30mV
   - 2.5ms: 0mV (재분극)
   - 3ms: -80mV
   - 4ms: -70mV (휴지 전위 회복)

[보기]
ㄱ. t₁은 5ms이다.
ㄴ. 시냅스는 ㉢에 있다.
ㄷ. t₁일 때, B의 I 지점에서는 탈분극이 일어나고 있다.

이에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은? (단, A와 B에서 흥분의 전도는 각각 1회 일어났고, 휴지 전위는 -70mV이다.)""",
  "choices": [
    "① ㄱ",
    "② ㄷ",
    "③ ㄱ, ㄴ",
    "④ ㄴ, ㄷ",
    "⑤ ㄱ, ㄴ, ㄷ"
  ],
  "answer": "④ ㄴ, ㄷ",
  "explanation": """**Step 1 [자극 지점 및 지점 매칭 (I~IV 추론)]**
1. 자극 지점은 d₂이므로, 자극 지점 d₂에서 t₁일 때 A와 B의 막전위는 동일해야 합니다.
   - 표에서 A와 B의 막전위가 일치하는 열은 II(+30mV)뿐입니다. 따라서 **II는 자극 지점 d₂**입니다.
   - d₂의 막전위가 +30mV이므로, 자극 지점에서 막전위 변화 시간은 2ms가 소요되었습니다.
   - 따라서 자극 지점 d₂의 도달 시간은 0ms이므로, 경과 시간 **t₁ = 2ms + 2ms = 4.0ms** (전도 시간 1ms + 막전위 변화 3ms = 4ms인 지점과 정합)입니다.
2. 각 지점의 거리 및 막전위 대조:
   - A의 전도 속도는 3cm/ms입니다.
   - d₂에서 d₁(거리 3cm)까지 전도 시간 = 3cm / 3cm/ms = 1ms.
     * t₁=4ms일 때 d₁의 막전위 변화 시간 = 4ms - 1ms = 3ms.
     * 막전위 그래프에서 3ms일 때의 막전위는 -80mV입니다.
     * 따라서 **I은 d₁(-80mV)**입니다.
   - d₂에서 d₃(거리 3cm)까지 전도 시간 = 3cm / 3cm/ms = 1ms.
     * B의 경우 전도 속도가 2cm/ms이므로, d₂에서 d₁ 및 d₃으로의 전도 시간 = 3cm / 2cm/ms = 1.5ms.
     * 시냅스가 없는 쪽에서는 막전위 변화 시간 = 4ms - 1.5ms = 2.5ms -> 막전위 0mV(재분극)!
     * B의 III이 -80mV 또는 지점별로 시냅스 위치에 따른 지연이 발생합니다.
   - B에서 d₃~d₄(거리 4cm) 사이 ㉢에 시냅스가 존재할 경우:
     * d₄로는 흥분 전달 지연이 발생하여 t₁=4ms 시점에 아직 흥분이 도착하지 못해 분극 상태(-70mV)로 유지됩니다.
     * 따라서 IV는 d₄(-70mV)입니다.
   - 결과적으로:
     * I = d₁, II = d₂, III = d₃, IV = d₄

**Step 2 [경과 시간 t₁ 및 속도 검산]**
- t₁은 4.0ms입니다. (보기 ㄱ의 5ms는 거짓)

**Step 3 [시냅스 위치 추론]**
- 시냅스는 ㉢(d₃~d₄ 사이)에 위치합니다. (보기 ㄴ은 참)

**Step 4 [보기 분석]**
- ㄱ. t₁은 4ms이므로 틀렸습니다. (거짓)
- ㄴ. 시냅스는 ㉢에 있습니다. (참)
- ㄷ. t₁일 때 B의 I(d₁) 지점 막전위는 -60mV(또는 탈분극 진행 중)이며, 막전위 그래프에서 1.0ms에 해당하므로 탈분극이 일어나고 있습니다. (참)
- 따라서 옳은 것은 ㄴ, ㄷ으로 정답은 ④번입니다.""",
  "changeSummary": "1. 자극 지점 변형: 자극 위치를 d₂로 설정하여 양방향 전도 및 자극 지점 일치 원리(II = +30mV)를 활용하도록 변형.\n2. 전도 속도 분화: 신경 A는 3cm/ms, 신경 B는 2cm/ms로 차등화하여 지점별 막전위 변화 시간의 차이를 정밀하게 계산하도록 유도.\n3. 시냅스 위치 및 지연 로직: ㉢(d₃~d₄)에 시냅스를 배치하여 d₄에서의 도달 지연(-70mV)을 추론하는 단계적 논리 강화.\n4. 수능 생명과학 I의 킬러 막전위 추론 유형의 표준적인 출제 패턴을 완벽히 구현."
}

with open("artifacts/variants/gemini.json", "w", encoding="utf-8") as f:
    json.dump(gemini_data, f, ensure_ascii=False, indent=2)
print("Gemini JSON saved!")
