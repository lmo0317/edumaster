#!/usr/bin/env node
'use strict';
// Accounts from the server's shell (the first admin, or a forgotten password). The password is read from stdin —
// typed, or piped — never from the command line, so it stays out of the shell history and the process list.
//   node scripts/user.js list
//   node scripts/user.js add <name> [admin|teacher]
//   node scripts/user.js passwd <name>
const path = require('path');
const readline = require('readline');
const { createUsers } = require('../server/users');

const dataDir = process.env.EDUMASTER_DATA_DIR || path.join(__dirname, '..', 'data');
const users = createUsers(dataDir);
const [cmd, name, role = 'admin'] = process.argv.slice(2);

function readPassword() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) process.stdout.write('비밀번호: ');
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.once('line', (line) => { rl.close(); resolve(line.replace(/\r$/, '')); });
    rl.once('close', () => resolve(''));
  });
}

(async () => {
  if (cmd === 'list') {
    for (const u of users.list()) console.log(`${u.username}\t${u.role}${u.disabled ? '\t(꺼짐)' : ''}`);
    return;
  }
  if (cmd === 'add' && name) {
    const u = users.create({ username: name, password: await readPassword(), role });
    console.log(`계정을 만들었습니다: ${u.username} (${u.role})`);
    return;
  }
  if (cmd === 'passwd' && name) {
    const u = users.list().find((x) => x.username === name.toLowerCase());
    if (!u) throw new Error('계정을 찾지 못했습니다.');
    users.setPassword(u.id, await readPassword());
    console.log(`비밀번호를 바꿨습니다: ${u.username}`);
    return;
  }
  console.log('사용법: node scripts/user.js list | add <name> [admin|teacher] | passwd <name>  (비밀번호는 입력으로)');
  process.exitCode = 1;
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
