import os
import urllib.request
import mimetypes
import uuid
import json

def upload_images(base_url, token, q_path, s_path):
    boundary = uuid.uuid4().hex
    headers = {
        'Content-Type': f'multipart/form-data; boundary={boundary}',
        'Authorization': f'Bearer {token}'
    }
    
    with open(q_path, 'rb') as f:
        q_bytes = f.read()
    with open(s_path, 'rb') as f:
        s_bytes = f.read()
        
    parts = []
    
    def add_field(name, value):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode('utf-8'))
        
    def add_file(name, filename, data, mime):
        header = f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode('utf-8')
        parts.append(header + data + b'\r\n')
        
    add_field('provider', 'deepseek')
    add_field('materialKind', 'problem-solution-separate')
    add_file('questionFile', 'question.png', q_bytes, 'image/png')
    add_file('solutionFile', 'solution.png', s_bytes, 'image/png')
    
    body = b''.join(parts) + f'--{boundary}--\r\n'.encode('utf-8')
    
    req = urllib.request.Request(f'{base_url}/api/import', data=body, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            print("Import SUCCESS!")
            print("Title:", data.get('title'))
            print("Body:", data.get('body')[:200])
            print("Answer:", data.get('answer'))
            print("Steps:", data.get('steps'))
            print("SourceId:", data.get('sourceId'))
            with open('artifacts/imported_material.json', 'w', encoding='utf-8') as out:
                json.dump(data, out, ensure_ascii=False, indent=2)
            return data
    except urllib.error.HTTPError as e:
        print("Import HTTP error:", e.code, e.read().decode('utf-8'))
    except Exception as e:
        print("Import general error:", e)

if __name__ == '__main__':
    upload_images('https://minohlee.mooo.com/edumaster', os.environ['EDUMASTER_ACCESS_CODE'], 'question.png', 'solution.png')
