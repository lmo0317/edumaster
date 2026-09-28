'use strict';
// Local UI development without paid calls: mock model, separate data folder, fixed access code "dev".
const fs = require('node:fs');
const path = require('node:path');
process.env.EDUMASTER_LLM = 'mock';
process.env.EDUMASTER_MOCK_DELAY_MS = process.env.EDUMASTER_MOCK_DELAY_MS || '1500';
process.env.EDUMASTER_DATA_DIR = process.env.EDUMASTER_DATA_DIR || path.join(__dirname, '..', 'data-mock');
process.env.EDUMASTER_PORT = process.env.EDUMASTER_PORT || '18390';
fs.mkdirSync(process.env.EDUMASTER_DATA_DIR, { recursive: true });
const code = path.join(process.env.EDUMASTER_DATA_DIR, 'access-code.txt');
if (!fs.existsSync(code)) fs.writeFileSync(code, 'dev\n');
const { createApp } = require('../server/index.js');
const { server, config } = createApp();
server.listen(config.port, config.host, () => console.log(`mock dev server http://${config.host}:${config.port}  (접속 코드: dev)`));
