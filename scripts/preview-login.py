"""Disposable browser fixture: fake credential only, no real API or user data."""
import json
import base64
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

web = Path('src/EduMaster.Web/wwwroot')


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/fixture-png' or '--result' not in sys.argv:
            self.send_error(404)
            return
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 10000000:
            self.send_error(413)
            return
        png = base64.b64decode(self.rfile.read(length).decode().removeprefix('data:image/png;base64,'), validate=True)
        if not png.startswith(b'\x89PNG\r\n\x1a\n'):
            self.send_error(400)
            return
        name='material-web-same-image-output.png' if '--same-image' in sys.argv else 'material-web-problem-only-output.png' if '--problem-only' in sys.argv else 'material-web-separate-output.png' if '--separate' in sys.argv else 'material-web-output.png' if '--e2e' in sys.argv else 'problem-solution-output.png'
        Path('artifacts/evidence/web',name).write_bytes(png)
        self.send_response(204)
        self.end_headers()
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/status':
            ok = self.headers.get('Authorization') == 'Bearer fixture-login'
            content = json.dumps({'ready': True, 'model': '로그인 테스트 모델'} if ok else {'error': '비밀번호가 올바르지 않습니다.'}, ensure_ascii=False).encode()
            self.send_response(200 if ok else 401)
            content_type = 'application/json'
        elif path in ['/', '/index.html', '/app.js', '/style.css']:
            name = 'index.html' if path == '/' else path[1:]
            content = (web / name).read_bytes()
            if name == 'index.html' and '--result' in sys.argv:
                content = content.replace(b'</body>', b'<script src="fixture-result.js"></script></body>')
            self.send_response(200)
            content_type = 'text/javascript' if name.endswith('.js') else 'text/css' if name.endswith('.css') else 'text/html; charset=utf-8'
        elif path == '/fixture-result.js' and '--result' in sys.argv:
            name = 'material-web-same-image-smoke.json' if '--same-image' in sys.argv else 'material-web-problem-only-smoke.json' if '--problem-only' in sys.argv else 'material-web-separate-smoke.json' if '--separate' in sys.argv else 'material-web-smoke.json' if '--e2e' in sys.argv else 'problem-solution-generated.json' if '--generated' in sys.argv else 'problem-solution-variant.json'
            result = json.loads(Path('artifacts/evidence/web', name).read_text(encoding='utf-8'))
            if '--e2e' in sys.argv:result=result['generation']['result']
            content = ("$('lock-screen').hidden=true;$('main-studio').hidden=false;$('connection').textContent='로컬 출력 검증';show(" + json.dumps(result,ensure_ascii=False) + ");setTimeout(()=>{const image=document.getElementById('problem-image');if(image?.src.startsWith('data:image/png;base64,'))fetch('/fixture-png',{method:'POST',body:image.src});},1500);").encode()
            if '--series' in sys.argv:
                serialized=json.dumps(result,ensure_ascii=False)
                content+=("generationStarted=true;renderComparisons(["
                    "{stageNumber:1,stageCount:3,stageLabel:'STEP 1 연습 문제',state:'ready',phase:'완료',result:"+serialized+"},"
                    "{stageNumber:2,stageCount:3,stageLabel:'STEP 1~2 누적 연습 문제',state:'running',phase:'수치와 정답 검산 중'},"
                    "{stageNumber:3,stageCount:3,stageLabel:'전체 로직 쌍둥이 문제',state:'waiting',phase:'앞 단계 생성 대기'}"
                    "]);$('wizard-stage-5').hidden=false;$('feedback').hidden=false;$('feedback-title').textContent='문제 2/3 · STEP 1~2 누적 연습 문제';$('feedback-body').textContent='수치와 정답 검산 중\\n완료 1/3';$('badge').textContent='1/3 완료';").encode()
            if '--viewer' in sys.argv:content+=b"document.getElementById('preview').src='fixture-source.jpeg';document.getElementById('preview').hidden=false;"
            self.send_response(200)
            content_type = 'text/javascript; charset=utf-8'
        elif path == '/fixture-source.jpeg' and '--viewer' in sys.argv:
            content=Path('docs/샘플/샘플자료/원본이미지/02페이지_킬러문제와해설.jpeg').read_bytes()
            self.send_response(200)
            content_type='image/jpeg'
        else:
            self.send_error(404)
            return
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)


port = int(sys.argv[sys.argv.index('--port')+1]) if '--port' in sys.argv else 18385
ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
