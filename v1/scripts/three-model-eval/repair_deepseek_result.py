import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
path = root / "artifacts" / "three-model-eval" / "deepseek.json"
data = json.loads(path.read_text(encoding="utf-8"))

data["body"] = data["body"].replace(
    "A는 3cm/ms, B는 1cm/ms, d₁, d₂, d₃, d₄, 0, 3, 6, 9(cm)",
    "A는 3cm/ms, B는 1.5cm/ms, d₁, d₂, d₃, d₄, 0, 3, 7.5, 10.5(cm)",
).replace(
    "B를 구성하는 두 뉴런의 흥분 전도 속도는 1cm/ms로 같다.",
    "B를 구성하는 두 뉴런의 흥분 전도 속도는 1.5cm/ms로 같다.",
)

data["explanation"] = """STEP 1. 표에서 자극점 d₃의 A와 B 막전위는 같아야 한다. Ⅰ, Ⅱ, Ⅳ는 두 신경의 값이 다르므로 Ⅲ=d₃이다. A의 Ⅰ=-80mV는 흥분 도착 후 3ms에 해당하고, 자극점 오른쪽의 가장 가까운 지점이 d₄이므로 Ⅰ=d₄이다. 따라서 Ⅱ와 Ⅳ는 d₁, d₂ 중 하나이다.

STEP 2. A의 Ⅱ와 Ⅳ는 모두 0mV이다. 활동 전위 그래프에서 0mV는 흥분 도착 후 1.5ms와 2.5ms에 나타난다. d₁과 d₂의 거리 3cm를 이동하는 데 걸린 시간이 1ms이므로 A의 흥분 전도 속도는 3cm/ms이다. d₃에서 d₂까지는 4.5cm이므로 1.5ms, d₁까지는 7.5cm이므로 2.5ms가 걸린다. t₁=4ms일 때 d₂와 d₁에서 흥분 도착 후 경과 시간은 각각 2.5ms와 1.5ms이므로 두 지점 모두 0mV이다.

STEP 3. A의 d₃→d₄ 거리는 3cm이고 속도는 3cm/ms이므로 전도 시간은 1ms이다. d₄(Ⅰ)의 -80mV는 도착 후 3ms의 값이므로 t₁=1+3=4ms이다. B의 d₃→d₄는 3cm, 속도는 1.5cm/ms이므로 시냅스가 없다면 2ms 후 도착하고 t₁에서 도착 후 2ms가 지나 +30mV여야 한다. 실제 Ⅰ=d₄의 막전위는 0mV이므로 ⓒ의 시냅스에서 0.5ms가 지연되어 도착 후 1.5ms가 지난 것이다. B의 d₃→d₂는 4.5cm이므로 3ms가 걸리고, t₁에서 도착 후 1ms가 지나 -60mV이므로 Ⅱ=d₂, Ⅳ=d₁이다. ㄱ은 참, ㄴ은 참, ㄷ은 A의 Ⅱ=d₂에서 재분극이 일어나므로 거짓이다. 따라서 정답은 ③ ㄱ, ㄴ이다."""
data["choices"] = ["ㄱ", "ㄴ", "ㄱ, ㄴ", "ㄴ, ㄷ", "ㄱ, ㄴ, ㄷ"]
data["answer"] = "③ ㄱ, ㄴ"
data["steps"] = [
    "자극점의 두 막전위와 -80mV의 시간 위치를 이용해 Ⅲ=d₃, Ⅰ=d₄를 찾고 Ⅱ·Ⅳ를 d₁·d₂ 후보로 남긴다.",
    "A의 0mV 두 시각 차와 d₁~d₂ 거리로 A의 속도 3cm/ms를 구하고 Ⅱ=d₂, Ⅳ=d₁임을 확인한다.",
    "A의 d₄에서 t₁=4ms를 구한 뒤 B의 무시냅스 예측값과 실제값을 비교해 ⓒ의 시냅스와 보기를 판정한다.",
]
data["changeSummary"] = "DeepSeek가 구성한 보기와 3단계 풀이 틀을 유지했다. 첫 모델 초안이 원본 표를 새 거리와 함께 복사해 모순이 생겨, 시스템이 거리 0·3·7.5·10.5cm와 속도 A=3cm/ms, B=1.5cm/ms로 일관되게 재배치하고 표의 모든 막전위를 다시 대조했다."
data["systemRepair"] = {
    "applied": True,
    "reason": "모델 초안이 새 거리와 원본 막전위 표를 일관되지 않게 결합했고, ㄱ의 진릿값도 해설과 충돌함",
    "checks": [
        "A d₃→d₄: 3/3=1ms; 4-1=3ms → -80mV",
        "A d₃→d₂: 4.5/3=1.5ms; 4-1.5=2.5ms → 0mV",
        "A d₃→d₁: 7.5/3=2.5ms; 4-2.5=1.5ms → 0mV",
        "B d₃→d₂: 4.5/1.5=3ms; 4-3=1ms → -60mV",
        "B d₃→d₄: 3/1.5=2ms; 시냅스 지연 0.5ms → 경과 1.5ms, 0mV",
    ],
}
data["drawings"] = [{
    "title": "신경 A와 B의 지점 위치",
    "width": 1000,
    "height": 300,
    "description": "d₁=0, d₂=3, d₃=7.5, d₄=10.5cm와 d₃ 자극점 및 B의 시냅스 후보 구간",
    "elements": [
        {"type":"line","coordinates":[120,90,900,90],"text":"","fontSize":24,"dashed":False,"fill":"none"},
        {"type":"line","coordinates":[120,230,900,230],"text":"","fontSize":24,"dashed":False,"fill":"none"},
        {"type":"text","coordinates":[55,98],"text":"A","fontSize":28,"dashed":False,"fill":"none"},
        {"type":"text","coordinates":[55,238],"text":"B","fontSize":28,"dashed":False,"fill":"none"},
        *sum(([{"type":"line","coordinates":[x,76,x,104],"text":"","fontSize":20,"dashed":False,"fill":"none"},
                {"type":"line","coordinates":[x,216,x,244],"text":"","fontSize":20,"dashed":False,"fill":"none"},
                {"type":"text","coordinates":[x-35,55],"text":label,"fontSize":20,"dashed":False,"fill":"none"}]
              for x,label in [(140,"d₁ 0cm"),(346,"d₂ 3cm"),(654,"d₃ 7.5cm"),(860,"d₄ 10.5cm")]), []),
        {"type":"arrow","coordinates":[654,20,654,70],"text":"","fontSize":20,"dashed":False,"fill":"none"},
        {"type":"text","coordinates":[628,18],"text":"자극","fontSize":20,"dashed":False,"fill":"none"},
        {"type":"text","coordinates":[235,190],"text":"ⓐ","fontSize":24,"dashed":False,"fill":"none"},
        {"type":"text","coordinates":[490,190],"text":"ⓑ","fontSize":24,"dashed":False,"fill":"none"},
        {"type":"text","coordinates":[745,190],"text":"ⓒ","fontSize":24,"dashed":False,"fill":"none"},
    ],
}]
data["state"] = "system_repaired_draft"

path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("deepseek repaired", data["answer"])
