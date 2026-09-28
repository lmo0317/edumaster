from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit
import urllib.request,urllib.error
ROOT=Path('src/EduMaster.Web/wwwroot').resolve()
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path.startswith('/edumaster/api/'):
   request=urllib.request.Request('https://minohlee.mooo.com'+self.path,headers={k:v for k,v in self.headers.items() if k.lower() in ('authorization','x-edumaster-renderer')})
   try:
    with urllib.request.urlopen(request,timeout=20) as r:body=r.read();code=r.status;kind=r.headers.get('Content-Type','application/json')
   except urllib.error.HTTPError as e:body=e.read();code=e.code;kind='application/json'
   except Exception:body=b'{"error":"Preview API unavailable"}';code=502;kind='application/json'
   self.send_response(code);self.send_header('Content-Type',kind);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
  self.path=self.path.removeprefix('/edumaster');super().do_GET()
 def do_POST(self):self.send_error(405,'Read-only UI preview')
 def do_PUT(self):self.send_error(405,'Read-only UI preview')
print('Read-only UI preview on 127.0.0.1:18499',flush=True)
ThreadingHTTPServer(('127.0.0.1',18499),Handler).serve_forever()
