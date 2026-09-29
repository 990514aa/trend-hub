'use strict';
/**
 * 물리치료 기록 — 메인 PC 서버 (외부 라이브러리 없음)
 *
 * 메인 PC에서 실행하면 화면(Index.html)과 데이터 API를 제공한다.
 * 같은 네트워크의 다른 PC·태블릿은 http://<메인PC IP>:<포트> 로 접속한다.
 *
 * 데이터 폴더 (config.json 의 dataDir, 구글 드라이브 폴더로 지정하면 자동 백업):
 *   records/YYYY-MM.json   월별 치료 기록 {id: 기록}
 *   patients.json          환자(등록번호·이름·메모·최근처방)
 *   settings.json          앱 설정
 *   audit/YYYY-MM.jsonl    생성·수정·삭제 이력
 *   기록_YYYY-MM.csv       사람이 엑셀로 볼 수 있는 월별 대장 (저장할 때마다 갱신)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const sea = (() => { try { const s = require('node:sea'); return s.isSea() ? s : null; } catch (e) { return null; } })();
const APP_DIR = sea ? path.dirname(process.execPath) : __dirname;
const CONFIG_PATH = process.env.PT_CONFIG || path.join(APP_DIR, 'config.json');
const STATUS_KO = { running: '치료중', ended: '작성대기', done: '작성완료', cancelled: '취소', waiting: '대기' };

/* ---------------- 설정 ---------------- */
function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
  return { port: 8080, dataDir: path.join(APP_DIR, 'data'), pin: '', openBrowser: true, ...c };
}
let cfg = loadConfig();
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8'); }

function indexHtml() {
  if (sea) return sea.getAsset('Index.html', 'utf8');
  return fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');
}

/* ---------------- 파일 저장소 ---------------- */
const cache = new Map();
const P = (...a) => path.join(cfg.dataDir, ...a);
function readJSON(file, def) {
  if (cache.has(file)) return cache.get(file);
  let v = def;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  cache.set(file, v);
  return v;
}
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
function writeJSON(file, v) { cache.set(file, v); writeFileAtomic(file, JSON.stringify(v)); }
const month = d => String(d).slice(0, 7);
const recFile = m => P('records', m + '.json');
const recMonth = m => readJSON(recFile(m), {});
function monthsBetween(from, to) {
  const out = []; let y = +from.slice(0, 4), m = +from.slice(5, 7);
  const ty = +to.slice(0, 4), tm = +to.slice(5, 7);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 120) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  return out;
}
function allMonths() {
  try { return fs.readdirSync(P('records')).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 7)).sort(); } catch (e) { return []; }
}
function shiftDate(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const hm = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }) : '';

let VERSION = String(Date.now());
const bump = () => { VERSION = String(Date.now()); };

function boardRecords(date) {
  const from = shiftDate(date, -7), out = [];
  for (const m of monthsBetween(from, date)) for (const r of Object.values(recMonth(m))) {
    if (r.date === date || ((r.status === 'ended' || r.status === 'running') && r.date < date && r.date >= from)) out.push(r);
  }
  return out;
}
function auditDiff(a, b) {
  const items = r => (r.items || []).map(i => `${i.mid}:${i.min}분 ${i.start ? hm(i.start) : '-'}~${i.end ? hm(i.end) : '-'}`).join(' | ');
  const pick = r => r ? { 등록번호: r.regNo, 이름: r.name, 상태: r.status, 처방의: r.doctor, 시행자: r.therapist, 베드: r.bed, 항목: items(r), EMR입력: r.emrDone ? 'Y' : 'N' } : {};
  const x = pick(a), y = pick(b), out = [];
  for (const k of Object.keys(y)) if (String(x[k] ?? '') !== String(y[k] ?? '')) out.push(`${k}: ${x[k] ?? ''} → ${y[k] ?? ''}`);
  return out.join('\n');
}
function audit(id, regNo, action, changes, by) {
  const line = JSON.stringify({ ts: new Date().toISOString(), id, regNo: regNo || '', action, changes: changes || '', by: by || '' }) + '\n';
  const f = P('audit', month(new Date().toISOString().slice(0, 10)) + '.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, line, 'utf8');
}
function writeCsv(m) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const H = ['날짜', '등록번호', '이름', '구분', '치료실', '베드', '치료항목', '시작', '종료', '소요(분)', '처방의', '시행자', '상태', 'EMR입력', 'EMR 기록문', '수정일시', '수정기기'];
  const rows = Object.values(recMonth(m)).filter(r => r.status !== 'waiting').sort((a, b) => String(a.startAt || '').localeCompare(String(b.startAt || '')));
  const lines = [H.map(q).join(',')];
  for (const r of rows) {
    const st = (r.items || []).map(i => i.start).filter(Boolean).sort()[0] || r.startAt;
    const en = (r.items || []).map(i => i.end).filter(Boolean).sort().pop() || r.endAt;
    lines.push([r.date, r.regNo, r.name, r.visit, r.room === 'ex' ? '운동·특수' : '물리치료실', r.bed,
      (r.items || []).map(i => `${i.mid} ${i.min}분`).join(', '), hm(st), hm(en), st && en ? Math.round((new Date(en) - new Date(st)) / 60000) : '',
      r.doctor, r.therapist, STATUS_KO[r.status] || r.status, r.emrDone ? 'Y' : '', r.emrText, r.updatedAt, r.updatedBy].map(q).join(','));
  }
  try { writeFileAtomic(P(`기록_${m}.csv`), '﻿' + lines.join('\r\n')); } catch (e) { /* 엑셀에서 열려 있으면 다음 저장 때 갱신 */ }
}
function readPatients() { return readJSON(P('patients.json'), {}); }
function rememberPatient(pats, rec) {
  const p = pats[rec.regNo] || { regNo: rec.regNo, memo: '' };
  p.name = rec.name;
  p.plan = { room: rec.room, visit: rec.visit, dx: rec.dx, sites: rec.sites, side: rec.side, doctor: rec.doctor,
    items: (rec.items || []).map(i => ({ mid: i.mid, min: i.min, phase: i.phase, params: i.params })), date: rec.date };
  p.updatedAt = new Date().toISOString(); pats[rec.regNo] = p;
}

/* ---------------- API (Code.gs 와 같은 이름·동작) ---------------- */
const API = {
  bootstrap: date => ({ settings: readJSON(P('settings.json'), null), records: boardRecords(date), version: VERSION }),
  poll: (date, version) => version && version === VERSION ? { same: true } : ({ settings: readJSON(P('settings.json'), null), records: boardRecords(date), version: VERSION }),
  saveRecord(rec, base, by) {
    const m = month(rec.date), recs = recMonth(m), old = recs[rec.id];
    if (old && base && old.updatedAt !== base) return { conflict: true, record: old };
    const ch = auditDiff(old, rec);
    recs[rec.id] = rec; writeJSON(recFile(m), recs);
    if (ch) audit(rec.id, rec.regNo, old ? '수정' : '생성', ch, by);
    const pats = readPatients();
    if (rec.status === 'done') { rememberPatient(pats, rec); writeJSON(P('patients.json'), pats); }
    else if (rec.regNo && !pats[rec.regNo]) { pats[rec.regNo] = { regNo: rec.regNo, name: rec.name, memo: '', plan: null, updatedAt: new Date().toISOString() }; writeJSON(P('patients.json'), pats); }
    writeCsv(m); bump();
    return { record: rec };
  },
  deleteRecord(id, date, reason, by) {
    const m = month(date), recs = recMonth(m), old = recs[id];
    if (old) { delete recs[id]; writeJSON(recFile(m), recs); audit(id, old.regNo, '삭제', reason, by); writeCsv(m); bump(); }
    return { ok: true };
  },
  findPatients(q) {
    q = String(q || '').trim(); if (!q) return [];
    return Object.values(readPatients()).filter(p => String(p.regNo).startsWith(q) || String(p.name || '').includes(q)).slice(0, 20);
  },
  getPatient(regNo) {
    regNo = String(regNo || '').trim();
    const records = [];
    for (const m of allMonths()) for (const r of Object.values(recMonth(m))) if (r.regNo === regNo && r.status !== 'waiting') records.push(r);
    records.sort((a, b) => String(b.startAt || '').localeCompare(String(a.startAt || '')));
    return { patient: readPatients()[regNo] || null, records };
  },
  savePatient(p) {
    const pats = readPatients();
    pats[p.regNo] = { ...(pats[p.regNo] || {}), ...p, updatedAt: new Date().toISOString() };
    writeJSON(P('patients.json'), pats); return { patient: pats[p.regNo] };
  },
  saveSettings(s) { writeJSON(P('settings.json'), s); bump(); return { settings: s }; },
  listRange(from, to) {
    const out = [];
    for (const m of monthsBetween(from, to)) for (const r of Object.values(recMonth(m))) if (r.date >= from && r.date <= to) out.push(r);
    return out;
  },
  getAudit(id) {
    const out = [];
    let files = []; try { files = fs.readdirSync(P('audit')).filter(f => f.endsWith('.jsonl')).sort(); } catch (e) {}
    for (const f of files) for (const line of fs.readFileSync(P('audit', f), 'utf8').split('\n')) {
      if (!line.includes(id)) continue;
      try { const a = JSON.parse(line); if (a.id === id) out.push(a); } catch (e) {}
    }
    return out;
  },
};
// 메인 PC에서만 허용되는 관리 기능
const ADMIN = {
  serverInfo: (ctx) => ({ urls: lanUrls(), dataDir: cfg.dataDir, pinSet: !!cfg.pin, isLocal: ctx.local, version: VERSION }),
  setDataDir(ctx, dir) {
    if (!ctx.local) throw new Error('데이터 폴더는 메인 PC에서만 바꿀 수 있습니다.');
    dir = String(dir || '').trim(); if (!dir) throw new Error('폴더 경로를 입력하세요.');
    dir = path.resolve(dir);
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test'); fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    const hasData = fs.existsSync(path.join(dir, 'records')) || fs.existsSync(path.join(dir, 'patients.json'));
    if (!hasData && fs.existsSync(cfg.dataDir) && path.resolve(cfg.dataDir) !== dir) fs.cpSync(cfg.dataDir, dir, { recursive: true });
    cfg.dataDir = dir; saveConfig(); cache.clear(); bump();
    return { dataDir: dir, copied: !hasData };
  },
  setPin(ctx, pin) {
    if (!ctx.local) throw new Error('PIN은 메인 PC에서만 바꿀 수 있습니다.');
    cfg.pin = String(pin || '').trim(); saveConfig(); return { pinSet: !!cfg.pin };
  },
};

/* ---------------- HTTP ---------------- */
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${cfg.port}`);
  }
  return out;
}
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try { return send(res, 200, indexHtml(), 'text/html; charset=utf-8'); } catch (e) { return send(res, 500, '화면 파일을 찾을 수 없습니다.', 'text/plain; charset=utf-8'); }
  }
  if (url.pathname === '/favicon.ico') {
    return send(res, 200, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🩺</text></svg>', 'image/svg+xml');
  }
  if (req.method === 'POST' && url.pathname === '/api') {
    const local = isLocal(req);
    if (cfg.pin && !local && !safeEq(req.headers['x-pin'] || '', cfg.pin)) return send(res, 401, JSON.stringify({ error: 'PIN', needPin: true }));
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { method, args } = JSON.parse(body || '{}');
        let out;
        if (API[method]) out = API[method](...(args || []));
        else if (ADMIN[method]) out = ADMIN[method]({ local }, ...(args || []));
        else return send(res, 400, JSON.stringify({ error: '알 수 없는 요청: ' + method }));
        send(res, 200, JSON.stringify(out));
      } catch (e) {
        send(res, 200, JSON.stringify({ error: String(e && e.message || e) }));
      }
    });
    return;
  }
  send(res, 404, 'Not found', 'text/plain; charset=utf-8');
});

function openBrowser(u) {
  if (!cfg.openBrowser || process.env.PT_NO_BROWSER) return;
  const cmd = process.platform === 'win32' ? `start "" "${u}"` : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`;
  exec(cmd, () => {});
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n이미 실행 중입니다 (포트 ${cfg.port}). 화면만 엽니다.`);
    openBrowser(`http://localhost:${cfg.port}`);
    setTimeout(() => process.exit(0), 1500);
  } else { console.error(e); }
});

if (require.main === module || sea) {
  if (!fs.existsSync(CONFIG_PATH)) { try { saveConfig(); } catch (e) {} }
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  server.listen(cfg.port, '0.0.0.0', () => {
    const line = '─'.repeat(58);
    console.log(line);
    console.log('  물리치료 기록 — 메인 PC 서버 실행 중');
    console.log(line);
    console.log(`  이 PC에서      : http://localhost:${cfg.port}`);
    for (const u of lanUrls()) console.log(`  다른 PC·태블릿 : ${u}`);
    console.log(`  데이터 폴더    : ${cfg.dataDir}`);
    console.log(`  접속 PIN       : ${cfg.pin ? '설정됨' : '없음 (앱 [설정]에서 지정 권장)'}`);
    console.log(line);
    console.log('  ※ 이 창을 닫으면 다른 기기에서 접속할 수 없습니다. 최소화해 두세요.');
    console.log(line);
    openBrowser(`http://localhost:${cfg.port}`);
  });
}
module.exports = { API, ADMIN, server };
