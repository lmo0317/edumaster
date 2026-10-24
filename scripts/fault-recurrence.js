#!/usr/bin/env node
'use strict';
// 결함 재발 보기: every set in the given data folders (default: data/ and every eval/.work/*), in time order, with how
// many of its faults were of a kind already seen — in any set, in its own original — and how many broke a lesson that
// was in the writer's prompt; then the kinds that come back most. The number a learning system drives down.
//   node scripts/fault-recurrence.js [--since 2026-10-21] [dir ...]
const fs = require('node:fs');
const path = require('node:path');
const faults = require('../server/faults');

const args = process.argv.slice(2);
const sinceAt = args.indexOf('--since');
const since = sinceAt >= 0 ? args.splice(sinceAt, 2)[1] : '';
const root = path.join(__dirname, '..');
const dirs = args.length ? args : ['data', ...(fs.existsSync(path.join(root, 'eval/.work')) ? fs.readdirSync(path.join(root, 'eval/.work')).map((d) => path.join('eval/.work', d)) : [])]
  .map((d) => path.resolve(root, d)).filter((d) => fs.existsSync(path.join(d, 'jobs')));
const readAll = (d) => fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } }).filter(Boolean);

const sets = [];
for (const dir of dirs) {
  const jobs = readAll(path.join(dir, 'jobs')).filter((j) => j.type === 'generate' && Array.isArray(j.items) && j.items.some((it) => it.attempts?.length) && (!since || j.createdAt >= since));
  for (const j of jobs) sets.push({ dir: path.basename(dir), job: j, records: faults.index([j], { dataDir: dir }) });
}
sets.sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt));

console.log('날짜 | 폴더 | 원본 | 문제 | 완성 | 결함 | 재발 | 이 원본 재발 | 학습 위반');
const earlier = [];
let total = 0, repeat = 0, own = 0, lesson = 0;
for (const s of sets) {
  const st = faults.setStats(s.job, earlier);
  const made = s.job.items.filter((it) => ['passed', 'warning'].includes(it.status)).length;
  console.log([s.job.createdAt.slice(5, 16), s.dir.slice(0, 15), (s.job.material?.title || s.job.title || '').slice(0, 30), s.job.items.length, made, st.faults, st.repeat, st.own, st.lesson].join(' | '));
  total += st.faults; repeat += st.repeat; own += st.own; lesson += st.lesson;
  earlier.push(...s.records);
}
const pct = (n) => (total ? `${Math.round((100 * n) / total)}%` : '-');
console.log(`\n세트 ${sets.length}개 · 결함 ${total}건 — 전에 나온 종류 ${repeat}건 (${pct(repeat)}), 같은 원본에서 ${own}건 (${pct(own)}), 지시문의 학습이 이미 말한 것 ${lesson}건 (${pct(lesson)})`);

console.log('\n되풀이된 결함 (두 세트 이상): 건수 | 세트 | 원본 | 기준 | 예');
for (const g of faults.groupsOf(earlier).filter((g) => g.sets.size >= 2).sort((a, b) => b.sets.size - a.sets.size || b.n - a.n).slice(0, 25)) {
  console.log([g.n, g.sets.size, g.materials.size, g.rule, g.detail.replace(/\s+/g, ' ').slice(0, 100)].join(' | '));
}
