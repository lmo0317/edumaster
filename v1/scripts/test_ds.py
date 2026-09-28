import urllib.request
import json
import sys

def test_ds():
    with open("artifacts/web/deepseek-api-key.txt", "r", encoding="utf-8") as f:
        key = f.read().strip()
    url = "https://api.deepseek.com/chat/completions"
    payload = {
        "model": "deepseek-flash",
        "messages": [
            {"role": "user", "content": "반드시 JSON으로 응답: {\"status\": \"ok\", \"model\": \"deepseek\"}"}
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": 1024
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}"
    })
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        print("DS Raw:", res)

test_ds()
