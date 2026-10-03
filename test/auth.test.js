'use strict';
// Accounts (2026-10-03): sign-in by name and password instead of one shared access code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { createUsers } = require('../server/users');

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-auth-'));
  createUsers(dataDir).create({ username: 'admin', password: 'admin-pass-1', role: 'admin' });
  const app = createApp({ dataDir, llmMode: 'mock' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  // One browser: its own cookie.
  const browser = () => {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json() };
    };
  };
  return { dataDir, browser, close: () => new Promise((r) => app.server.close(r)) };
}

test('sign-in by name and password; a wrong name or password gets the same answer; the password is stored only as a hash', async () => {
  const s = await start();
  try {
    const b = s.browser();
    assert.equal((await b('GET', '/api/materials')).status, 401);
    const wrongPw = await b('POST', '/api/login', { username: 'admin', password: 'nope-nope' });
    const wrongName = await b('POST', '/api/login', { username: 'nobody', password: 'admin-pass-1' });
    assert.deepEqual([wrongPw.status, wrongName.status], [401, 401]);
    assert.equal(wrongPw.data.error, wrongName.data.error);
    const ok = await b('POST', '/api/login', { username: ' ADMIN ', password: 'admin-pass-1' });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.data.user.username, ok.data.user.role], ['admin', 'admin']);
    assert.equal((await b('GET', '/api/me')).data.username, 'admin');
    assert.equal((await b('GET', '/api/status')).data.user.username, 'admin');
    const stored = fs.readFileSync(path.join(s.dataDir, 'users.json'), 'utf8');
    assert.ok(!stored.includes('admin-pass-1') && stored.includes('scrypt'));
  } finally { await s.close(); }
});

test('five wrong passwords for a name lock it for a while, even with the right one', async () => {
  const s = await start();
  try {
    const b = s.browser();
    for (let i = 0; i < 5; i++) assert.equal((await b('POST', '/api/login', { username: 'admin', password: 'wrong-' + i })).status, 401);
    assert.equal((await b('POST', '/api/login', { username: 'admin', password: 'admin-pass-1' })).status, 429);
  } finally { await s.close(); }
});

test('changing one\'s password needs the current one and signs out the other devices', async () => {
  const s = await start();
  try {
    const a = s.browser(); const other = s.browser();
    await a('POST', '/api/login', { username: 'admin', password: 'admin-pass-1' });
    await other('POST', '/api/login', { username: 'admin', password: 'admin-pass-1' });
    assert.equal((await a('PUT', '/api/me/password', { current: 'wrong-one', next: 'new-pass-22' })).status, 400);
    assert.equal((await a('PUT', '/api/me/password', { current: 'admin-pass-1', next: 'short' })).status, 400);
    assert.equal((await a('PUT', '/api/me/password', { current: 'admin-pass-1', next: 'new-pass-22' })).status, 200);
    assert.equal((await a('GET', '/api/me')).status, 200, 'this device stays signed in');
    assert.equal((await other('GET', '/api/me')).status, 401, 'the other device is signed out');
    assert.equal((await s.browser()('POST', '/api/login', { username: 'admin', password: 'new-pass-22' })).status, 200);
  } finally { await s.close(); }
});

test('an admin manages accounts; a teacher cannot; a switched-off account is signed out; one admin always remains', async () => {
  const s = await start();
  try {
    const admin = s.browser();
    await admin('POST', '/api/login', { username: 'admin', password: 'admin-pass-1' });
    const t = (await admin('POST', '/api/users', { username: 'kim', password: 'teacher-pass', role: 'teacher' })).data;
    assert.equal(t.role, 'teacher');
    assert.equal((await admin('POST', '/api/users', { username: 'kim', password: 'teacher-pass' })).status, 409);
    assert.equal((await admin('POST', '/api/users', { username: 'X!', password: 'teacher-pass' })).status, 400);
    const teacher = s.browser();
    await teacher('POST', '/api/login', { username: 'kim', password: 'teacher-pass' });
    assert.equal((await teacher('GET', '/api/materials')).status, 200, 'a teacher uses the app');
    assert.equal((await teacher('GET', '/api/users')).status, 403, 'but does not manage accounts');
    // Reset by the admin, then switched off: the teacher is signed out and cannot sign in.
    assert.equal((await admin('PUT', '/api/users/' + t.id, { password: 'reset-pass-1' })).status, 200);
    assert.equal((await teacher('GET', '/api/me')).status, 401);
    await admin('PUT', '/api/users/' + t.id, { disabled: true });
    assert.equal((await s.browser()('POST', '/api/login', { username: 'kim', password: 'reset-pass-1' })).status, 401);
    // The admin cannot switch off or delete itself, and the last admin cannot go.
    const me = (await admin('GET', '/api/me')).data;
    assert.equal((await admin('PUT', '/api/users/' + me.id, { disabled: true })).status, 409);
    assert.equal((await admin('DELETE', '/api/users/' + me.id)).status, 409);
    assert.equal((await admin('DELETE', '/api/users/' + t.id)).status, 200);
    assert.deepEqual((await admin('GET', '/api/users')).data.map((u) => u.username), ['admin']);
  } finally { await s.close(); }
});

test('a session from the access-code days (no account) no longer signs anyone in', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-auth-'));
  createUsers(dataDir).create({ username: 'admin', password: 'admin-pass-1', role: 'admin' });
  const crypto = require('node:crypto');
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({ [hash]: { created: Date.now(), expires: Date.now() + 86400000 } }));
  const app = createApp({ dataDir, llmMode: 'mock' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/materials`, { headers: { cookie: `em2_session=${token}` } });
    assert.equal(res.status, 401);
  } finally { await new Promise((r) => app.server.close(r)); }
});
