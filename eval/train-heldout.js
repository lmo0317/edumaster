'use strict';
// 학습 반복 on the originals of an eval run, in that run's own data folder (teacher data is never touched):
//   node eval/train-heldout.js <stamp> <case,...> [target] [maxRounds]
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');

const [stamp, cases, target = '90', maxRounds = '6'] = process.argv.slice(2);
const dataDir = path.join(__dirname, '.work', stamp);

(async () => {
  const app = createApp({ dataDir, llmMode: 'deepseek', relay: { dir: '', label: 'relay', timeoutMs: 3 * 3600 * 1000 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${url}: ${data.error}`);
    return data;
  };
  await call('POST', '/api/login', { username: 'eval', password: 'eval-harness' });
  const dir = path.join(dataDir, 'materials');
  const materials = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const runs = [];
  for (const name of cases.split(',')) {
    const material = materials.find((m) => m.title.includes(`] ${name} ·`));
    const started = await call('POST', '/api/generations', { materialId: material.id, mode: 'integrated', provider: 'claude-cli', train: { target: Number(target), maxRounds: Number(maxRounds) } });
    console.log(name, material.id, started.trainJobId);
    runs.push([name, started.trainJobId]);
  }
  for (;;) {
    const jobs = await Promise.all(runs.map(([, id]) => call('GET', `/api/jobs/${id}`)));
    console.log(new Date().toISOString(), jobs.map((j, i) => `${runs[i][0]}:${j.status}${j.reached ? '(도달)' : ''}:${JSON.stringify(j.rounds || [])}`).join('\n  '));
    if (jobs.every((j) => ['done', 'failed', 'cancelled', 'interrupted'].includes(j.status))) break;
    await new Promise((r) => setTimeout(r, 300000));
  }
  await new Promise((r) => app.server.close(r));
  process.exit(0);
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
