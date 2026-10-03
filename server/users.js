'use strict';
// Accounts (data/users.json): a username, a role (admin: also manages accounts; teacher: uses the app) and a scrypt
// hash of the password with its own salt. Passwords are never stored or logged. Created on the server with
// `node scripts/user.js add <name>` (the first account) and on the 계정 page by an admin after that.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROLES = new Set(['admin', 'teacher']);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };
const NAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PW_MIN = 8;
const PW_MAX = 128;

const fail = (status, message) => Object.assign(new Error(message), { status });

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const dk = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return { alg: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), dk: dk.toString('base64') };
}
function matches(password, h) {
  const dk = crypto.scryptSync(String(password), Buffer.from(h.salt, 'base64'), Buffer.from(h.dk, 'base64').length, { N: h.N, r: h.r, p: h.p, maxmem: 128 * h.N * h.r * 2 });
  return crypto.timingSafeEqual(dk, Buffer.from(h.dk, 'base64'));
}
// Checked against when the name is unknown, so a wrong name takes as long as a wrong password.
const DUMMY = hashPassword('not-a-password');

function checkPassword(password) {
  const p = String(password || '');
  if (p.length < PW_MIN) throw fail(400, `비밀번호는 ${PW_MIN}자 이상이어야 합니다.`);
  if (p.length > PW_MAX) throw fail(400, `비밀번호는 ${PW_MAX}자까지 쓸 수 있습니다.`);
  return p;
}
function checkName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!NAME_RE.test(n)) throw fail(400, '아이디는 영문 소문자·숫자·._- 로 3~32자여야 합니다 (첫 글자는 영문이나 숫자).');
  return n;
}
const view = (u) => ({ id: u.id, username: u.username, role: u.role, disabled: Boolean(u.disabled), createdAt: u.createdAt, updatedAt: u.updatedAt, lastLoginAt: u.lastLoginAt || '' });

function createUsers(dataDir) {
  const file = path.join(dataDir, 'users.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || []; } catch { return []; } };
  const write = (list) => { fs.writeFileSync(file, JSON.stringify(list, null, 1), { mode: 0o600 }); fs.chmodSync(file, 0o600); };
  const admins = (list) => list.filter((u) => u.role === 'admin' && !u.disabled);
  return {
    count: () => read().length,
    list: () => read().map(view),
    get: (id) => { const u = read().find((x) => x.id === id); return u ? view(u) : null; },
    /** The account for this name and password, or null. Always does one scrypt, found or not. */
    verify(name, password) {
      const n = String(name || '').trim().toLowerCase();
      const list = read();
      const u = list.find((x) => x.username === n);
      const ok = matches(String(password || ''), u ? u.hash : DUMMY);
      if (!u || !ok || u.disabled) return null;
      u.lastLoginAt = new Date().toISOString();
      write(list);
      return view(u);
    },
    create({ username, password, role = 'teacher' }) {
      const n = checkName(username);
      if (!ROLES.has(role)) throw fail(400, '역할은 관리자 또는 선생님이어야 합니다.');
      const list = read();
      if (list.some((x) => x.username === n)) throw fail(409, '이미 있는 아이디입니다.');
      const now = new Date().toISOString();
      const u = { id: crypto.randomBytes(8).toString('hex'), username: n, role, hash: hashPassword(checkPassword(password)), createdAt: now, updatedAt: now };
      write([...list, u]);
      return view(u);
    },
    setPassword(id, password) {
      const list = read();
      const u = list.find((x) => x.id === id);
      if (!u) throw fail(404, '계정을 찾지 못했습니다.');
      u.hash = hashPassword(checkPassword(password));
      u.updatedAt = new Date().toISOString();
      write(list);
      return view(u);
    },
    update(id, { role, disabled }) {
      const list = read();
      const u = list.find((x) => x.id === id);
      if (!u) throw fail(404, '계정을 찾지 못했습니다.');
      if (role !== undefined) { if (!ROLES.has(role)) throw fail(400, '역할은 관리자 또는 선생님이어야 합니다.'); u.role = role; }
      if (disabled !== undefined) u.disabled = Boolean(disabled);
      if (!admins(list).length) throw fail(409, '관리자가 한 명은 남아 있어야 합니다.');
      u.updatedAt = new Date().toISOString();
      write(list);
      return view(u);
    },
    remove(id) {
      const list = read();
      const next = list.filter((x) => x.id !== id);
      if (next.length === list.length) throw fail(404, '계정을 찾지 못했습니다.');
      if (!admins(next).length) throw fail(409, '관리자가 한 명은 남아 있어야 합니다.');
      write(next);
    },
  };
}

module.exports = { createUsers, hashPassword, PW_MIN, ROLES };
