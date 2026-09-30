/**
 * 물리치료 기록 — Google Apps Script 서버
 *
 * 데이터는 이 스크립트가 연결된 구글 스프레드시트에만 저장된다.
 *   기록_YYYY-MM : 월별 치료 기록 (한 행 = 환자 1명의 1회 치료)
 *   환자         : 등록번호·이름·최근 처방·메모
 *   설정         : 처방의·치료사 명단, 치료 항목 설정 (JSON)
 *   수정이력     : 생성·수정·삭제 이력 (누가·언제·무엇을)
 *
 * 설치 방법은 README.md 참고. 처음 한 번 setup() 을 실행한다.
 */

var SHEET_PATIENTS = '환자';
var SHEET_SETTINGS = '설정';
var SHEET_AUDIT = '수정이력';
var REC_PREFIX = '기록_';
var REC_HEADERS = ['ID', '날짜', '등록번호', '이름', '구분', '치료실', '베드', '치료항목', '시작', '종료', '소요(분)',
                   '처방의', '시행자', '상태', 'EMR입력', 'EMR 기록문', '수정일시', '수정기기', 'DATA'];
var COL = { id: 1, regNo: 3, status: 14, data: 19 };
var PAT_HEADERS = ['등록번호', '이름', '메모', '최근처방', '수정일시'];
var AUDIT_HEADERS = ['일시', '기록ID', '등록번호', '작업', '변경내용', '기기'];
var STATUS_KO = { running: '치료중', ended: '작성대기', done: '작성완료', cancelled: '취소', waiting: '대기' };

/* ---------------- 웹앱 ---------------- */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('물리치료 기록')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 처음 한 번 실행: 시트 생성 + 이 스프레드시트를 저장소로 지정 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('스프레드시트의 [확장 프로그램 → Apps Script] 에서 만든 스크립트여야 합니다.');
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  sheet_(SHEET_PATIENTS, PAT_HEADERS);
  sheet_(SHEET_SETTINGS, ['설정(JSON) — 앱의 [설정] 화면에서 바꾸세요']);
  sheet_(SHEET_AUDIT, AUDIT_HEADERS);
  recSheet_(today_());
  bump_();
  return '설치 완료: ' + ss.getName();
}

/** 화면(Index.html)에서 호출하는 단일 진입점. 인자·결과 모두 JSON 문자열. */
function api(method, argsJson) {
  var args = JSON.parse(argsJson || '[]');
  var fn = API_[method];
  if (!fn) return JSON.stringify({ error: '알 수 없는 요청: ' + method });
  try {
    return JSON.stringify(fn.apply(null, args));
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message || e) });
  }
}

var API_ = {
  bootstrap: function (date) {
    return { settings: getSettings_(), records: boardRecords_(date), version: version_() };
  },
  poll: function (date, version) {
    var v = version_();
    if (version && version === v) return { same: true };
    return { settings: getSettings_(), records: boardRecords_(date), version: v };
  },
  saveRecord: function (rec, base, by) {
    return withLock_(function () {
      var sh = recSheet_(rec.date);
      var row = findRow_(sh, rec.id);
      var old = row ? JSON.parse(sh.getRange(row, COL.data).getValue() || 'null') : null;
      if (old && base && old.updatedAt !== base) return { conflict: true, record: old };
      var values = [recRow_(rec)];
      if (row) sh.getRange(row, 1, 1, REC_HEADERS.length).setValues(values);
      else appendRow_(sh, values[0]);
      var ch = auditDiff_(old, rec);
      if (ch) audit_(rec.id, rec.regNo, old ? '수정' : '생성', ch, by);
      if (rec.status === 'done') rememberPatient_(rec);
      else if (rec.regNo && !findPatientRow_(rec.regNo)) savePatientRow_({ regNo: rec.regNo, name: rec.name, memo: '', plan: null });
      bump_();
      return { record: rec };
    });
  },
  deleteRecord: function (id, date, reason, by) {
    return withLock_(function () {
      var sh = recSheet_(date);
      var row = findRow_(sh, id);
      if (row) {
        var old = JSON.parse(sh.getRange(row, COL.data).getValue() || '{}');
        sh.deleteRow(row);
        audit_(id, old.regNo || '', '삭제', reason || '', by);
        bump_();
      }
      return { ok: true };
    });
  },
  findPatients: function (q) {
    q = String(q || '').trim();
    if (!q) return [];
    var sh = sheet_(SHEET_PATIENTS, PAT_HEADERS);
    var n = sh.getLastRow() - 1;
    if (n < 1) return [];
    var vals = sh.getRange(2, 1, n, 5).getValues();
    var out = [];
    for (var i = 0; i < vals.length; i++) {
      var reg = String(vals[i][0]), name = String(vals[i][1]);
      if (reg.indexOf(q) !== 0 && name.indexOf(q) < 0) continue;
      var plan = null; try { plan = vals[i][3] ? JSON.parse(vals[i][3]) : null; } catch (e) {}
      out.push({ regNo: reg, name: name, memo: String(vals[i][2] || ''), updatedAt: String(vals[i][4] || ''),
                 last: plan ? { date: plan.date, items: (plan.items || []).map(function (x) { return x.mid; }) } : null });
    }
    // 등록번호 앞자리 일치 우선, 그다음 최근 방문 순
    out.sort(function (a, b) {
      return ((b.regNo.indexOf(q) === 0) - (a.regNo.indexOf(q) === 0)) || b.updatedAt.localeCompare(a.updatedAt);
    });
    return out.slice(0, 10);
  },
  getPatient: function (regNo) {
    regNo = String(regNo || '').trim();
    var patient = readPatient_(regNo);
    var records = [];
    var sheets = ss_().getSheets();
    for (var s = 0; s < sheets.length; s++) {
      var sh = sheets[s];
      if (sh.getName().indexOf(REC_PREFIX) !== 0 || sh.getLastRow() < 2) continue;
      var cells = sh.getRange(2, COL.regNo, sh.getLastRow() - 1, 1)
        .createTextFinder(regNo).matchEntireCell(true).findAll();
      for (var c = 0; c < cells.length; c++) {
        var r = JSON.parse(sh.getRange(cells[c].getRow(), COL.data).getValue() || 'null');
        if (r && r.status !== 'waiting') records.push(r);
      }
    }
    records.sort(function (a, b) { return String(b.startAt || '').localeCompare(String(a.startAt || '')); });
    return { patient: patient, records: records };
  },
  savePatient: function (p) {
    return withLock_(function () {
      var cur = readPatient_(p.regNo) || {};
      var merged = { regNo: p.regNo, name: p.name || cur.name || '', memo: p.memo != null ? p.memo : (cur.memo || ''), plan: p.plan || cur.plan || null };
      savePatientRow_(merged);
      return { patient: readPatient_(p.regNo) };
    });
  },
  saveSettings: function (s) {
    return withLock_(function () {
      var sh = sheet_(SHEET_SETTINGS, ['설정(JSON) — 앱의 [설정] 화면에서 바꾸세요']);
      sh.getRange(2, 1).setNumberFormat('@').setValue(JSON.stringify(s));
      bump_();
      return { settings: s };
    });
  },
  listRange: function (from, to) {
    var out = [];
    var months = monthsBetween_(from, to);
    for (var i = 0; i < months.length; i++) {
      var sh = ss_().getSheetByName(REC_PREFIX + months[i]);
      if (!sh) continue;
      readAll_(sh).forEach(function (r) { if (r.date >= from && r.date <= to) out.push(r); });
    }
    return out;
  },
  getAudit: function (id) {
    var sh = sheet_(SHEET_AUDIT, AUDIT_HEADERS);
    if (sh.getLastRow() < 2) return [];
    var cells = sh.getRange(2, 2, sh.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findAll();
    return cells.map(function (c) {
      var v = sh.getRange(c.getRow(), 1, 1, 6).getValues()[0];
      return { ts: v[0], id: v[1], regNo: v[2], action: v[3], changes: v[4], by: v[5] };
    });
  }
};

/* ---------------- 시트 도우미 ---------------- */
function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('설치가 끝나지 않았습니다. Apps Script 편집기에서 setup 을 먼저 실행하세요.');
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  return ss;
}
function sheet_(name, headers) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#eef2f7');
    sh.setFrozenRows(1);
    // 등록번호 앞자리 0, 시각 문자열이 자동 변환되지 않도록 전부 텍스트 서식
    sh.getRange(1, 1, sh.getMaxRows(), Math.max(headers.length, 1)).setNumberFormat('@');
  }
  return sh;
}
function recSheet_(date) {
  var sh = sheet_(REC_PREFIX + String(date).slice(0, 7), REC_HEADERS);
  if (sh.getColumnWidth(COL.data) > 60) {
    sh.setColumnWidth(COL.data, 60);
    sh.setColumnWidth(16, 360);
  }
  return sh;
}
function findRow_(sh, id) {
  if (sh.getLastRow() < 2) return 0;
  var cell = sh.getRange(2, COL.id, sh.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}
function readAll_(sh) {
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, COL.data, sh.getLastRow() - 1, 1).getValues()
    .map(function (v) { try { return JSON.parse(v[0]); } catch (e) { return null; } })
    .filter(function (r) { return r; });
}
/** 현황판: 오늘 전체 + 최근 7일 중 작성대기·치료중 (Index.html inBoard 와 같은 규칙) */
function boardRecords_(date) {
  var from = shiftDate_(date, -7);
  var months = monthsBetween_(from, date);
  var out = [];
  for (var i = 0; i < months.length; i++) {
    var sh = ss_().getSheetByName(REC_PREFIX + months[i]);
    if (!sh) continue;
    readAll_(sh).forEach(function (r) {
      if (r.date === date || ((r.status === 'ended' || r.status === 'running') && r.date < date && r.date >= from)) out.push(r);
    });
  }
  return out;
}
function recRow_(r) {
  var items = r.items || [];
  var starts = items.map(function (i) { return i.start; }).filter(Boolean).sort();
  var ends = items.map(function (i) { return i.end; }).filter(Boolean).sort();
  var st = starts[0] || r.startAt || '', en = ends[ends.length - 1] || r.endAt || '';
  var minutes = st && en ? Math.round((new Date(en) - new Date(st)) / 60000) : '';
  return [
    r.id, r.date, r.regNo || '', r.name || '', r.visit || '', r.room === 'ex' ? '운동·특수' : (r.room ? '물리치료실' : ''), r.bed || '',
    items.map(function (i) { return i.mid + ' ' + i.min + '분'; }).join(', '),
    hm_(st), hm_(en), String(minutes), r.doctor || '', r.therapist || '', STATUS_KO[r.status] || r.status,
    r.emrDone ? 'Y' : '', r.emrText || '', r.updatedAt || '', r.updatedBy || '', JSON.stringify(r)
  ];
}
function readPatient_(regNo) {
  var row = findPatientRow_(regNo);
  if (!row) return null;
  var v = sheet_(SHEET_PATIENTS, PAT_HEADERS).getRange(row, 1, 1, 5).getValues()[0];
  var plan = null;
  try { plan = v[3] ? JSON.parse(v[3]) : null; } catch (e) {}
  return { regNo: String(v[0]), name: String(v[1]), memo: String(v[2] || ''), plan: plan, updatedAt: v[4] };
}
function findPatientRow_(regNo) {
  var sh = sheet_(SHEET_PATIENTS, PAT_HEADERS);
  if (sh.getLastRow() < 2 || !regNo) return 0;
  var cell = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(String(regNo)).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}
function savePatientRow_(p) {
  var sh = sheet_(SHEET_PATIENTS, PAT_HEADERS);
  var values = [p.regNo, p.name || '', p.memo || '', p.plan ? JSON.stringify(p.plan) : '', new Date().toISOString()];
  var row = findPatientRow_(p.regNo);
  if (row) sh.getRange(row, 1, 1, 5).setValues([values]);
  else appendRow_(sh, values);
}
/** 맨 아래에 한 행 추가. 시트 행이 모자라면 텍스트 서식으로 500행씩 늘린다. */
function appendRow_(sh, values) {
  var row = sh.getLastRow() + 1;
  if (row > sh.getMaxRows()) {
    var from = sh.getMaxRows();
    sh.insertRowsAfter(from, 500);
    sh.getRange(from + 1, 1, 500, sh.getMaxColumns()).setNumberFormat('@');
  }
  sh.getRange(row, 1, 1, values.length).setValues([values]);
}
/** 환자별 최근 처방 기억 (Index.html rememberPatient 와 같은 규칙) */
function rememberPatient_(rec) {
  var cur = readPatient_(rec.regNo) || { memo: '' };
  savePatientRow_({
    regNo: rec.regNo, name: rec.name, memo: cur.memo,
    plan: {
      room: rec.room, visit: rec.visit, dx: rec.dx, sites: rec.sites, side: rec.side, doctor: rec.doctor,
      items: (rec.items || []).map(function (i) { return { mid: i.mid, min: i.min, phase: i.phase, params: i.params }; }),
      date: rec.date
    }
  });
}
function getSettings_() {
  var sh = ss_().getSheetByName(SHEET_SETTINGS);
  if (!sh || sh.getLastRow() < 2) return null;
  try { return JSON.parse(sh.getRange(2, 1).getValue()); } catch (e) { return null; }
}

/* ---------------- 수정 이력 ---------------- */
function auditDiff_(a, b) {
  function items(r) {
    return (r.items || []).map(function (i) { return i.mid + ':' + i.min + '분 ' + (i.start ? hm_(i.start) : '-') + '~' + (i.end ? hm_(i.end) : '-'); }).join(' | ');
  }
  function pick(r) {
    if (!r) return {};
    return { '등록번호': r.regNo, '이름': r.name, '상태': r.status, '처방의': r.doctor, '시행자': r.therapist, '베드': r.bed,
             '항목': items(r), 'EMR입력': r.emrDone ? 'Y' : 'N' };
  }
  var x = pick(a), y = pick(b), out = [];
  Object.keys(y).forEach(function (k) {
    var xv = x[k] == null ? '' : String(x[k]), yv = y[k] == null ? '' : String(y[k]);
    if (xv !== yv) out.push(k + ': ' + xv + ' → ' + yv);
  });
  return out.join('\n');
}
function audit_(id, regNo, action, changes, by) {
  appendRow_(sheet_(SHEET_AUDIT, AUDIT_HEADERS), [new Date().toISOString(), id, regNo || '', action, changes || '', by || '']);
}

/* ---------------- 기타 ---------------- */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('다른 기기가 저장 중입니다. 잠시 후 다시 시도하세요.');
  try { return fn(); } finally { lock.releaseLock(); }
}
function version_() { return PropertiesService.getScriptProperties().getProperty('VERSION') || '0'; }
function bump_() { PropertiesService.getScriptProperties().setProperty('VERSION', String(Date.now())); }
function today_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'); }
function hm_(iso) { return iso ? Utilities.formatDate(new Date(iso), 'Asia/Seoul', 'HH:mm') : ''; }
function shiftDate_(ymd, n) {
  var p = ymd.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}
function monthsBetween_(from, to) {
  var out = [], y = +from.slice(0, 4), m = +from.slice(5, 7);
  var ty = +to.slice(0, 4), tm = +to.slice(5, 7);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(y + '-' + (m < 10 ? '0' : '') + m);
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
