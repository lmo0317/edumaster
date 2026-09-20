'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'public');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.txt':'text/plain; charset=utf-8'};
const assets=new Set(['index.html','style.css','app.js','samples/reaction.png','samples/reaction-original.png','samples/reaction-reconstructed.png','samples/structure.png','samples/graph.png','samples/example.txt']);
const security={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"};
http.createServer((req,res)=>{
  let url;try{url=new URL(req.url,'http://localhost');}catch{res.writeHead(400).end();return;}
  if(url.pathname.startsWith('/api/')){
    const upstream=http.request({hostname:'127.0.0.1',port:18282,path:url.pathname+url.search,method:req.method,headers:req.headers},response=>{
      res.writeHead(response.statusCode,{...response.headers,...security});response.pipe(res);
    });
    upstream.setTimeout(330000,()=>upstream.destroy());
    upstream.on('error',()=>{if(!res.headersSent){res.writeHead(503,{'Content-Type':'application/json; charset=utf-8',...security});res.end(JSON.stringify({error:'문제 처리 서버와 연결이 잠시 끊겼습니다. 서버 재시작 중일 수 있습니다. 잠시 후 다시 시도해 주세요.'}));}else res.destroy();});
    req.on('aborted',()=>upstream.destroy());req.pipe(upstream);return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return;}
  let relative;try{relative=decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g,'')||'index.html';}catch{res.writeHead(400).end();return;}
  if(!assets.has(relative)){res.writeHead(404,security).end();return;}
  fs.stat(path.join(root,relative),(error,stat)=>{
    if(error){res.writeHead(404,security).end();return;}
    const download=url.searchParams.has('download')?{'Content-Disposition':'attachment; filename="'+path.basename(relative)+'"'}:{};
    res.writeHead(200,{'Content-Type':types[path.extname(relative)],'Content-Length':stat.size,...security,...download});
    if(req.method==='HEAD')res.end();else fs.createReadStream(path.join(root,relative)).on('error',()=>res.destroy()).pipe(res);
  });
}).listen(18280,'127.0.0.1',()=>console.log('EduMaster web gateway listening on 127.0.0.1:18280'));
