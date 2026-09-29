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
// 설정·데이터는 exe 위치와 무관한 사용자 폴더에 둔다 (exe를 옮기거나 새 버전으로 바꿔도, zip 안에서 실행해도 유지)
//   윈도우: %APPDATA%\물리치료기록   그 외: ~/.물리치료기록
const HOME_DIR = process.env.PT_HOME || (process.platform === 'win32' && process.env.APPDATA
  ? path.join(process.env.APPDATA, '물리치료기록') : path.join(os.homedir(), '.물리치료기록'));
const CONFIG_PATH = process.env.PT_CONFIG || path.join(HOME_DIR, 'config.json');
const LEGACY_CONFIG = path.join(APP_DIR, 'config.json');   // 이전 버전: exe 옆에 저장
// zip 안에서 바로 실행하면 윈도우가 임시 폴더에 풀어 실행하고 나중에 지운다
const TEMP_RUN = !!sea && (path.resolve(process.execPath).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()) || /\.zip[\\/]/i.test(process.execPath));
const STATUS_KO = { running: '치료중', ended: '작성대기', done: '작성완료', cancelled: '취소', waiting: '대기' };

/* ---------------- 설정 ---------------- */
function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
  return { port: 8080, dataDir: path.join(HOME_DIR, 'data'), pin: '', openBrowser: true, ...c };
}
/** 이전 버전(exe 옆 config.json·data)에서 사용자 폴더로 한 번만 옮긴다 */
function migrateLegacy() {
  if (process.env.PT_CONFIG || fs.existsSync(CONFIG_PATH) || !fs.existsSync(LEGACY_CONFIG)) return;
  try {
    const old = JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8'));
    const oldData = path.resolve(old.dataDir || path.join(APP_DIR, 'data'));
    const next = { ...old };
    if (oldData === path.resolve(APP_DIR, 'data') && fs.existsSync(oldData)) {   // 기본 위치(exe 옆)였으면 데이터도 복사
      next.dataDir = path.join(HOME_DIR, 'data');
      fs.cpSync(oldData, next.dataDir, { recursive: true });
    }
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
    console.log(`  이전 설정·데이터를 ${HOME_DIR} 로 옮겼습니다.`);
  } catch (e) { console.error('  이전 설정 이전 실패:', e.message); }
}
migrateLegacy();
let cfg = loadConfig();
function saveConfig() { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

function indexHtml() {
  if (sea) return sea.getAsset('Index.html', 'utf8');
  return fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');
}

/* ---------------- 파일 저장소 ---------------- */
const cache = new Map();
const P = (...a) => path.join(cfg.dataDir, ...a);
/** 파일이 없으면 기본값. 있는데 못 읽으면 .bak 에서 복구, 그것도 안 되면 오류 —
 *  읽기 실패를 '빈 데이터'로 보고 덮어써서 기록이 사라지는 일을 막는다 */
function readJSON(file, def) {
  if (cache.has(file)) return cache.get(file);
  let v;
  if (!fs.existsSync(file)) v = def;
  else {
    const tryRead = f => { for (let i = 0; i < 5; i++) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { sleep(150); } } return undefined; };
    v = tryRead(file);
    if (v === undefined && fs.existsSync(file + '.bak')) {
      v = tryRead(file + '.bak');
      if (v !== undefined) console.error(`  ${path.basename(file)} 손상 → 백업(.bak)에서 복구했습니다.`);
    }
    if (v === undefined) throw new Error(`데이터 파일을 읽을 수 없습니다: ${file} (구글 드라이브 동기화·다른 프로그램 사용 중인지 확인 후 다시 시도)`);
  }
  cache.set(file, v);
  return v;
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
/** 임시 파일에 쓰고 바꿔치기. 직전 파일은 .bak 로 보관. 잠긴 파일(구글 드라이브·백신)은 잠시 후 재시도 */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  for (let i = 0; ; i++) {
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
      sleep(200 * (i + 1));
    }
  }
}
/** 하루 한 번 데이터 폴더 전체를 사용자 폴더 backups/날짜 에 복사, 30일치 보관 */
let lastBackup = '';
function dailyBackup() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  if (lastBackup === today) return;
  lastBackup = today;
  try {
    const root = path.join(HOME_DIR, 'backups'), dest = path.join(root, today);
    if (!fs.existsSync(dest) && fs.existsSync(cfg.dataDir)) {
      fs.cpSync(cfg.dataDir, dest, { recursive: true, filter: src => !/\.(tmp|bak)$/.test(src) });
    }
    const days = fs.existsSync(root) ? fs.readdirSync(root).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
    for (const d of days.slice(0, Math.max(0, days.length - 30))) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  } catch (e) { console.error('  자동 백업 실패:', e.message); }
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
    dailyBackup();
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
  serverInfo: (ctx) => ({ urls: lanUrls(), dataDir: cfg.dataDir, homeDir: HOME_DIR, backupDir: path.join(HOME_DIR, 'backups'), tempRun: TEMP_RUN, pinSet: !!cfg.pin, isLocal: ctx.local, version: VERSION }),
  setDataDir(ctx, dir) {
    if (!ctx.local) throw new Error('데이터 폴더는 메인 PC에서만 바꿀 수 있습니다.');
    dir = String(dir || '').trim(); if (!dir) throw new Error('폴더 경로를 입력하세요.');
    dir = path.resolve(dir);
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test'); fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    const hasData = fs.existsSync(path.join(dir, 'records')) || fs.existsSync(path.join(dir, 'patients.json'));
    if (!hasData && fs.existsSync(cfg.dataDir) && path.resolve(cfg.dataDir) !== dir) fs.cpSync(cfg.dataDir, dir, { recursive: true, filter: src => !/\.tmp$/.test(src) });
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
  if (!fs.existsSync(CONFIG_PATH)) { try { saveConfig(); } catch (e) { console.error('  설정 저장 실패:', e.message); } }
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  dailyBackup();
  server.listen(cfg.port, '0.0.0.0', () => {
    const line = '─'.repeat(58);
    console.log(line);
    console.log('  물리치료 기록 — 메인 PC 서버 실행 중');
    console.log(line);
    console.log(`  이 PC에서      : http://localhost:${cfg.port}`);
    for (const u of lanUrls()) console.log(`  다른 PC·태블릿 : ${u}`);
    console.log(`  데이터 폴더    : ${cfg.dataDir}`);
    console.log(`  자동 백업      : ${path.join(HOME_DIR, 'backups')} (날짜별 30일)`);
    console.log(`  접속 PIN       : ${cfg.pin ? '설정됨' : '없음 (앱 [설정]에서 지정 권장)'}`);
    console.log(line);
    console.log('  ※ 이 창을 닫으면 다른 기기에서 접속할 수 없습니다. 최소화해 두세요.');
    if (TEMP_RUN) {
      console.log(line);
      console.log('  ⚠ zip 파일 안에서 바로 실행했습니다. 기록은 안전하게 저장되지만,');
      console.log('    exe가 임시 폴더라 곧 지워집니다. zip을 [압축 풀기] 한 뒤 푼 폴더의 exe를 실행하세요.');
    }
    console.log(line);
    openBrowser(`http://localhost:${cfg.port}`);
  });
}
module.exports = { API, ADMIN, server };
