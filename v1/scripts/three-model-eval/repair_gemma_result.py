import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
path = root / "artifacts" / "three-model-eval" / "gemma-text.json"
data = json.loads(path.read_text(encoding="utf-8"))

data["title"] = "흥분 전도 속도와 시냅스 위치 - 2배 비례 변형"
data["body"] = """민말이집 신경 A와 B의 네 지점 d₁, d₂, d₃, d₄는 순서대로 0, 4, 10, 14cm에 있다. B는 2개의 뉴런으로 이루어져 있고, 구간 ⓐ(d₁~d₂), ⓑ(d₂~d₃), ⓒ(d₃~d₄) 중 한 곳에만 시냅스가 있다. A와 B의 d₃에 동시에 1회 자극을 주었다.

표는 자극 후 같은 시각 t₁에서 측정한 막전위이다. Ⅰ~Ⅳ는 d₁~d₄를 순서 없이 나타낸다.

| 구분 | Ⅰ | Ⅱ | Ⅲ | Ⅳ |
|---|---:|---:|---:|---:|
| A (mV) | -80 | 0 | ? | 0 |
| B (mV) | 0 | -60 | ? | -70 |

B를 구성하는 두 뉴런의 흥분 전도 속도는 2cm/ms로 같다. 두 신경의 활동 전위는 흥분 도착 후 경과 시간 0, 1, 1.5, 2, 2.5, 3, 4ms에서 막전위가 각각 -70, -60, 0, +30, 0, -80, -70mV로 변한다. 자극 전 휴지 전위는 -70mV이며, 두 신경에서 흥분은 각각 한 번 일어난다.

다음 설명 중 옳은 것만을 <보기>에서 고르시오.
ㄱ. A의 흥분 전도 속도는 4cm/ms이다.
ㄴ. 시냅스는 ⓒ에 있다.
ㄷ. t₁일 때 B의 Ⅱ에서는 재분극이 일어나고 있다."""
data["choices"] = ["ㄱ", "ㄴ", "ㄱ, ㄴ", "ㄴ, ㄷ", "ㄱ, ㄴ, ㄷ"]
data["answer"] = "③ ㄱ, ㄴ"
data["explanation"] = """STEP 1. 자극점 d₃에서는 A와 B의 막전위가 같아야 한다. Ⅰ, Ⅱ, Ⅳ는 두 신경의 값이 다르므로 Ⅲ=d₃이다. A의 Ⅰ=-80mV는 흥분 도착 후 3ms의 값이고 자극점 오른쪽의 가장 가까운 지점이 d₄이므로 Ⅰ=d₄이다. 따라서 Ⅱ와 Ⅳ는 d₁, d₂ 중 하나이다.

STEP 2. A의 Ⅱ와 Ⅳ는 모두 0mV이다. 활동 전위에서 0mV는 흥분 도착 후 1.5ms와 2.5ms에 나타난다. d₁과 d₂ 사이의 4cm를 전도하는 데 걸린 시간이 1ms이므로 A의 속도는 4cm/ms이다. d₃에서 d₂까지는 6cm이므로 1.5ms, d₁까지는 10cm이므로 2.5ms가 걸린다. t₁에서 두 지점의 경과 시간은 각각 2.5ms와 1.5ms이므로 Ⅱ=d₂, Ⅳ=d₁이다.

STEP 3. A의 d₃→d₄ 거리는 4cm이고 속도는 4cm/ms이므로 전도 시간은 1ms이다. d₄의 -80mV는 도착 후 3ms이므로 t₁=4ms이다. B의 d₃→d₂는 6cm이고 속도는 2cm/ms이므로 3ms 후 도착한다. t₁에서 경과 시간은 1ms이고 막전위 -60mV는 탈분극 중이므로 ㄷ은 거짓이다. B의 d₃→d₄는 시냅스가 없다면 2ms 후 도착하여 t₁에서 +30mV여야 한다. 실제 값은 0mV이므로 ⓒ에서 0.5ms 지연되어 도착 후 1.5ms가 지난 것이다. ㄱ과 ㄴ만 옳으므로 정답은 ③이다."""
data["steps"] = [
    "동시 자극점의 막전위를 대조해 Ⅲ=d₃, -80mV의 시간 위치로 Ⅰ=d₄를 찾는다.",
    "0mV가 두 번 나타나는 시간 차와 d₁~d₂ 거리로 A의 속도 4cm/ms 및 Ⅱ=d₂, Ⅳ=d₁을 구한다.",
    "A에서 t₁=4ms를 구하고 B의 무시냅스 예측과 실제값을 비교해 ⓒ와 보기의 진릿값을 판정한다.",
]
data["changeSummary"] = "Gemma가 만든 비례 변형 방향을 유지했다. 모델 초안의 좌표·막전위·t₁이 서로 맞지 않아 시스템이 원본 거리와 속도를 모두 2배로 맞추고 표의 각 칸과 보기를 다시 계산했다."
data["systemRepair"] = {
    "applied": True,
    "reason": "모델 초안의 거리·속도·표·보기 진릿값이 서로 충돌함",
    "checks": [
        "A d₃→d₄: 4/4=1ms; 4-1=3ms → -80mV",
        "A d₃→d₂: 6/4=1.5ms; 4-1.5=2.5ms → 0mV",
        "A d₃→d₁: 10/4=2.5ms; 4-2.5=1.5ms → 0mV",
        "B d₃→d₂: 6/2=3ms; 4-3=1ms → -60mV",
        "B d₃→d₄: 4/2=2ms; 시냅스 지연 0.5ms → 경과 1.5ms, 0mV",
    ],
}
data["drawings"] = [{
    "title": "신경 A와 B의 지점 위치",
    "width": 1000,
    "height": 300,
    "description": "d₁=0, d₂=4, d₃=10, d₄=14cm와 d₃ 자극점 및 B의 시냅스 후보 구간",
    "elements": [
        {"type":"line","coordinates":[120,90,900,90],"text":"","fontSize":24,"dashed":False,"fill":"none"},
        {"type":"line","coordinates":[120,230,900,230],"text":"","fontSize":24,"dashed":False,"fill":"none"},
        {"type":"text","coordinates":[55,98],"text":"A","fontSize":28,"dashed":False,"fill":"none"},
        {"type":"text","coordinates":[55,238],"text":"B","fontSize":28,"dashed":False,"fill":"none"},
        *sum(([{"type":"line","coordinates":[x,76,x,104],"text":"","fontSize":20,"dashed":False,"fill":"none"},
                {"type":"line","coordinates":[x,216,x,244],"text":"","fontSize":20,"dashed":False,"fill":"none"},
                {"type":"text","coordinates":[x-35,55],"text":label,"fontSize":20,"dashed":False,"fill":"none"}]
              for x,label in [(140,"d₁ 0cm"),(346,"d₂ 4cm"),(654,"d₃ 10cm"),(860,"d₄ 14cm")]), []),
        {"type":"arrow","coordinates":[654,20,654,70],"text":"","fontSize":20,"dashed":False,"fill":"none"},
        {"type":"text","coordinates":[628,18],"text":"자극","fontSize":20,"dashed":False,"fill":"none"},
        {"type":"text","coordinates":[235,190],"text":"ⓐ","fontSize":24,"dashed":False,"fill":"none"},
        {"type":"text","coordinates":[490,190],"text":"ⓑ","fontSize":24,"dashed":False,"fill":"none"},
        {"type":"text","coordinates":[745,190],"text":"ⓒ","fontSize":24,"dashed":False,"fill":"none"},
    ],
}]
data["state"] = "system_repaired_draft"

path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("gemma repaired", data["answer"])
