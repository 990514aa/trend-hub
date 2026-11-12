/**
 * 카피바라 온천 귀환 — 협동 멀티 중계 서버 (zero-dependency WebSocket)
 *
 * 역할은 "방 단위 중계 + 최소한의 판정"뿐이다. 게임 시뮬레이션은 브라우저가 한다.
 *  - 방(room): 코드로 구분, 최대 4명. 필드에 아무도 없으면 필드 상태를 초기화한다.
 *  - 구역(zone 0~2): 그 구역에 가장 먼저 들어온 사람이 호스트(적 AI 담당). 호스트가 나가면 다음 사람이 이어받는다.
 *  - 서버가 직접 판정하는 것: 전리품 줍기(같은 물건을 두 명이 갖지 못하게)와 호스트 지정.
 * 외부 의존성 없이 RFC 6455 핸드셰이크와 프레임을 직접 처리한다.
 */
'use strict';

const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PLAYERS = 4;
const MAX_FRAME = 256 * 1024;
const ZONES = 3;

const rooms = new Map();
let joinOrder = 0;

function frame(str, opcode = 1) {
  const payload = Buffer.from(str);
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
  return Buffer.concat([head, payload]);
}

function send(c, obj) {
  if (!c || c.sock.destroyed) return;
  try { c.sock.write(frame(JSON.stringify(obj))); } catch {}
}

function newZones() {
  return Array.from({ length: ZONES }, () => ({ taken: new Set(), boxes: [] }));
}

function hostOf(room, z) {
  let best = null;
  for (const c of room.clients.values()) if (c.zone === z && (!best || c.zoneAt < best.zoneAt)) best = c;
  return best ? best.id : 0;
}

function roster(room) {
  const hosts = [0, 1, 2].map((z) => hostOf(room, z));
  const players = [...room.clients.values()].map((c) => ({ id: c.id, name: c.name, zone: c.zone, host: c.zone >= 0 && hosts[c.zone] === c.id }));
  for (const c of room.clients.values()) send(c, { t: 'who', players });
}

function toZone(room, z, obj, except) {
  for (const c of room.clients.values()) if (c.zone === z && c !== except) send(c, obj);
}

// 필드에 아무도 없으면 다음 출격을 위해 전리품·상자 상태를 새로 깐다.
function resetFieldIfEmpty(room) {
  for (const c of room.clients.values()) if (c.zone >= 0) return;
  room.zones = newZones();
  room.epoch++;
}

function onMessage(c, m) {
  const room = c.room;
  if (!m || typeof m.t !== 'string') return;

  if (m.t === 'zone') {
    const z = Number.isInteger(m.z) && m.z >= -1 && m.z < ZONES ? m.z : -1;
    c.zone = z;
    c.zoneAt = ++joinOrder; // 구역에 먼저 들어온 사람이 그 구역의 호스트
    if (z < 0) resetFieldIfEmpty(room);
    else {
      const zs = room.zones[z];
      send(c, { t: 'zinfo', z, seed: (room.seed + room.epoch * 7919 + z * 101) >>> 0, host: hostOf(room, z), taken: [...zs.taken], boxes: zs.boxes, n: room.clients.size });
    }
    return roster(room);
  }

  if (c.zone < 0) return;
  const zs = room.zones[c.zone];

  if (m.t === 'take') {
    const u = String(m.u || '').slice(0, 40);
    if (!u) return;
    if (zs.taken.has(u)) return send(c, { t: 'deny', u });
    zs.taken.add(u);
    return toZone(room, c.zone, { t: 'took', b: String(m.b || '').slice(0, 40), u, id: c.id });
  }

  if (m.t === 'box' || m.t === 'kill') {
    if (m.t === 'kill' && hostOf(room, c.zone) !== c.id) return;
    const box = m.box;
    if (box && Array.isArray(box.items) && box.items.length <= 16 && JSON.stringify(box).length < 6000) {
      if (zs.boxes.length < 300) zs.boxes.push(box);
    } else if (m.t === 'box') return;
    m.id = c.id;
    return toZone(room, c.zone, m, c);
  }

  if (m.t === 's') {
    if (hostOf(room, c.zone) !== c.id) return;
    return toZone(room, c.zone, m, c);
  }

  if (m.t === 'p' || m.t === 'ev') {
    m.id = c.id;
    return toZone(room, c.zone, m, c);
  }
}

function drop(c) {
  const room = c.room;
  if (!room || !room.clients.delete(c.id)) return;
  if (!room.clients.size) { rooms.delete(room.code); return; }
  resetFieldIfEmpty(room);
  roster(room);
}

function handleUpgrade(req, socket) {
  const url = new URL(req.url, 'http://localhost');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/game/ws' || !key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);

  const code = (url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'LOBBY';
  const name = (url.searchParams.get('name') || '').replace(/[<>&"']/g, '').trim().slice(0, 12) || '카피바라';

  let room = rooms.get(code);
  if (!room) {
    room = { code, seed: crypto.randomBytes(4).readUInt32BE(0), epoch: 0, nextId: 1, clients: new Map(), zones: newZones() };
    rooms.set(code, room);
  }
  const c = { id: room.nextId++, name, zone: -1, sock: socket, zoneAt: ++joinOrder, room };
  if (room.clients.size >= MAX_PLAYERS) {
    send(c, { t: 'full' });
    socket.end(frame('', 8));
    return;
  }
  room.clients.set(c.id, c);
  send(c, { t: 'hi', id: c.id, room: code });
  roster(room);

  let buf = Buffer.alloc(0);
  let parts = [];
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, opcode = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(2) * 4294967296 + buf.readUInt32BE(6); off = 10; }
      if (len > MAX_FRAME || !masked) { socket.destroy(); return; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);

      if (opcode === 8) { socket.end(frame('', 8)); return; }
      if (opcode === 9) { try { socket.write(frame(data, 10)); } catch {} continue; }
      if (opcode === 10) continue;
      parts.push(data);
      if (!fin) { if (parts.length > 64) { socket.destroy(); return; } continue; }
      const text = Buffer.concat(parts).toString('utf8');
      parts = [];
      let msg = null;
      try { msg = JSON.parse(text); } catch {}
      try { onMessage(c, msg); } catch (e) { console.warn('[game-ws]', e.message); }
    }
  });
  const ping = setInterval(() => { try { socket.write(frame('', 9)); } catch {} }, 25000);
  const bye = () => { clearInterval(ping); drop(c); };
  socket.on('close', bye);
  socket.on('error', bye);
}

function attach(server) {
  server.on('upgrade', handleUpgrade);
}

module.exports = { attach, stats: () => ({ rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0) }) };
