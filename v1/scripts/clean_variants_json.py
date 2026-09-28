import json
import re

def clean(obj):
    if isinstance(obj, str):
        s = re.sub(r'\\*t?ext\{([^}]+)\}', r'\1', obj)
        s = re.sub(r'\\sim', '~', s)
        s = s.replace('d_1', 'd₁').replace('d_2', 'd₂').replace('d_3', 'd₃').replace('d_4', 'd₄')
        s = s.replace('t_1', 't₁').replace('t_2', 't₂')
        s = re.sub(r'\$([^$]+)\$', r'\1', s)
        s = s.replace('$', '')
        return s
    elif isinstance(obj, list):
        return [clean(x) for x in obj]
    elif isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    return obj

for name in ['gemma', 'deepseek', 'gemini']:
    p = f'artifacts/variants/{name}.json'
    with open(p, 'r', encoding='utf-8') as f:
        d = json.load(f)
    cleaned = clean(d)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(cleaned, f, ensure_ascii=False, indent=2)

with open('artifacts/variants/gemma.json', 'r', encoding='utf-8') as f:
    g = json.load(f)
with open('artifacts/variants/deepseek.json', 'r', encoding='utf-8') as f:
    d = json.load(f)
with open('artifacts/variants/gemini.json', 'r', encoding='utf-8') as f:
    m = json.load(f)

v_data = {'gemma': g, 'deepseek': d, 'gemini': m}
with open('src/EduMaster.Web/wwwroot/result/variants_data.json', 'w', encoding='utf-8') as f:
    json.dump(v_data, f, ensure_ascii=False, indent=2)
with open('variants_data.json', 'w', encoding='utf-8') as f:
    json.dump(v_data, f, ensure_ascii=False, indent=2)

print('Cleaned variants data saved successfully.')
