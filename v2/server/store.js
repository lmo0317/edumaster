'use strict';
// Small JSON-file store. Every record is one file so a crash can only lose the record being written,
// and writes go through a temp file + rename so readers never see half a document.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const newId = () => crypto.randomBytes(12).toString('hex');
const isId = (id) => typeof id === 'string' && /^[a-f0-9]{16,64}$/.test(id);

class Collection {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  file(id) {
    if (!isId(id)) throw Object.assign(new Error('잘못된 식별자입니다.'), { status: 400 });
    return path.join(this.dir, id + '.json');
  }
  get(id) {
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; }
  }
  put(record) {
    const target = this.file(record.id);
    const temp = target + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(record, null, 1));
    fs.renameSync(temp, target);
    return record;
  }
  remove(id) {
    try { fs.unlinkSync(this.file(id)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }
  all() {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const record = this.get(name.slice(0, -5));
      if (record) out.push(record);
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
}

class Files {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  saveDataUrl(dataUrl) {
    const match = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!match) throw Object.assign(new Error('PNG/JPEG/WEBP 이미지만 넣을 수 있습니다.'), { status: 400 });
    const id = newId();
    const ext = match[2] === 'jpeg' ? 'jpg' : match[2];
    const bytes = Buffer.from(match[3], 'base64');
    if (bytes.length < 100) throw Object.assign(new Error('이미지 파일이 비어 있습니다.'), { status: 400 });
    fs.writeFileSync(path.join(this.dir, `${id}.${ext}`), bytes);
    return { id, mime: match[1], bytes: bytes.length };
  }
  find(id) {
    if (!isId(id)) return null;
    for (const ext of ['jpg', 'png', 'webp']) {
      const file = path.join(this.dir, `${id}.${ext}`);
      if (fs.existsSync(file)) return { file, mime: ext === 'jpg' ? 'image/jpeg' : 'image/' + ext };
    }
    return null;
  }
  dataUrl(id) {
    const found = this.find(id);
    if (!found) return null;
    return `data:${found.mime};base64,` + fs.readFileSync(found.file).toString('base64');
  }
}

function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    dataDir,
    materials: new Collection(path.join(dataDir, 'materials')),
    jobs: new Collection(path.join(dataDir, 'jobs')),
    rules: new Collection(path.join(dataDir, 'rules')),
    usage: new Collection(path.join(dataDir, 'usage')),
    files: new Files(path.join(dataDir, 'files')),
  };
}

module.exports = { openStore, newId, isId };
