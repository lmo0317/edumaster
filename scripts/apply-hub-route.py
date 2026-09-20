#!/usr/bin/env python3
import re
import sys
from pathlib import Path

server_js = Path('/home/lmo0317/apps/planner/server.js')
content = server_js.read_text(encoding='utf-8')

# 1. Add net import if not present
if "const net = require('net');" not in content:
    content = content.replace("const https = require('https');", "const https = require('https');\nconst net = require('net');")

# 2. Add checkPort helper and /api/hub/status endpoint right before app.get('/kidsnote'
hub_status_code = '''
function checkPort(port, host = '127.0.0.1', timeout = 350) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let resolved = false;
    socket.setTimeout(timeout);
    socket.once('connect', () => {
      if (!resolved) { resolved = true; socket.destroy(); resolve(true); }
    });
    socket.once('timeout', () => {
      if (!resolved) { resolved = true; socket.destroy(); resolve(false); }
    });
    socket.once('error', () => {
      if (!resolved) { resolved = true; socket.destroy(); resolve(false); }
    });
    socket.connect(port, host);
  });
}

app.get('/api/hub/status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const [kidsnote, edumaster, edumasterBackend, openwebui, gemma, ollama] = await Promise.all([
      checkPort(9000),
      checkPort(18280),
      checkPort(18282),
      checkPort(8080),
      checkPort(8081),
      checkPort(11434)
    ]);
    res.json({
      ok: true,
      services: {
        planner: true,
        kidsnote,
        edumaster,
        edumasterBackend,
        openwebui,
        gemma,
        ollama
      },
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
'''

if '/api/hub/status' not in content:
    content = content.replace("app.get('/kidsnote',", hub_status_code + "\napp.get('/kidsnote',")

# 3. Replace app.get('/', ...) block
old_root_route = """app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const forceDesktop = req.query.desktop === '1';
  const useMobileFrontend = !forceDesktop && mobileUserAgentPattern.test(req.get('user-agent') || '');
  res.sendFile(path.join(__dirname, 'public', useMobileFrontend ? 'mobile.html' : 'index.html'));
});"""

new_routes = """function sendPlannerApp(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const forceDesktop = req.query.desktop === '1';
  const useMobileFrontend = !forceDesktop && mobileUserAgentPattern.test(req.get('user-agent') || '');
  res.sendFile(path.join(__dirname, 'public', useMobileFrontend ? 'mobile.html' : 'index.html'));
}

// Hub / Portal Page at Root
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'hub.html'));
});

// Dedicated Planner route
app.get(['/planner', '/planner/', '/planner/index.html'], sendPlannerApp);
app.get(['/planner/m', '/planner/mobile'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

// Serve planner assets under /planner
app.use('/planner', express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (path.extname(filePath) === '.html') {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// Fallback safety for /edumaster
app.get(['/edumaster', '/edumaster/*'], (req, res) => {
  res.redirect(302, '/edumaster/');
});"""

if old_root_route in content:
    content = content.replace(old_root_route, new_routes)
else:
    print('Warning: old_root_route exact match not found; checking regex')

# 4. Replace catch-all at bottom
old_catchall = """// Serve frontend SPA index.html for all other routes
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});"""

new_catchall = """// Planner SPA catch-all
app.get('/planner/*', sendPlannerApp);

// Catch-all for all other routes: serve hub
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'hub.html'));
});"""

if old_catchall in content:
    content = content.replace(old_catchall, new_catchall)
else:
    print('Warning: old_catchall exact match not found')

server_js.write_text(content, encoding='utf-8')
print('Successfully updated server.js')
