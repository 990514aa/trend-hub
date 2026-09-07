/* ================================================================
   TrendHub 3D 해부도 — WebGL(three.js) 렌더러
   분해도(exploded) · 투시(X-ray) · 단면도(cutaway)
   - three.js 는 public/vendor/ 에 동봉 (CDN·npm install 불필요)
   - WebGL 이 없으면 xray.js 의 CSS 3D 버전으로 자동 폴백된다
   ================================================================ */

import * as THREE from './vendor/three.module.min.js';

const SECTIONS = [
  { key: 'google',  icon: '🔍', name: '실시간 핫토픽',   src: 'trends.google.com/trending/rss', varName: '--google' },
  { key: 'youtube', icon: '▶',  name: '유튜브 인기',     src: 'youtubei/v1/search',             varName: '--youtube' },
  { key: 'shorts',  icon: '⚡', name: '쇼츠 트렌딩',     src: 'shortsLockupViewModel',          varName: '--shorts' },
  { key: 'tiktok',  icon: '🎵', name: '틱톡 인기 영상',   src: 'tikwm.com/api/feed/list',        varName: '--tiktok' },
  { key: 'x',       icon: '𝕏',  name: 'X 실시간 트렌드', src: 'trends24.in',                    varName: '--x' },
  { key: 'threads', icon: '@',  name: '스레드 핫키워드', src: '핫키워드 → 검색 링크',            varName: '--threads' },
];

const W = 3.2, H = 1.8, T = 0.11;        // 판 크기(월드 단위)
const TEX_W = 1280, TEX_H = 720;         // 판 위에 얹는 캔버스 텍스처 해상도
const ROWS = 5;
const N = SECTIONS.length;
const FONT = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

// ------------------------------------------------------------------ 유틸 --
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function fmtNum(n) {
  if (n == null) return '';
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '억';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '만';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + '천';
  return String(Math.round(n));
}

function parseMetric(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (!v) return null;
  const m = String(v).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([억만천KMB]?)/i);
  if (!m) return null;
  const mul = { '억': 1e8, '만': 1e4, '천': 1e3, K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return parseFloat(m[1]) * mul;
}

function metricOf(key, it, idx, total) {
  const raw = key === 'tiktok' ? it.plays
    : key === 'x' ? it.tweets
    : key === 'google' ? it.traffic
    : (key === 'youtube' || key === 'shorts') ? it.views
    : null;
  const n = parseMetric(raw);
  if (n != null) return { value: n, label: fmtNum(n) };
  return { value: (total - idx) / total, label: `#${idx + 1}` };
}

function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const c of kids) if (c) n.appendChild(c);
  return n;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

// ------------------------------------------------------- 판 텍스처 그리기 --
/** 섹션 한 장의 내용을 캔버스에 그린다. xray=true 면 투시용(투명 배경 + 발광선) */
function drawPlate(canvas, sec, data, tint, xray) {
  const ctx = canvas.getContext('2d');
  const items = data.items || [];
  ctx.clearRect(0, 0, TEX_W, TEX_H);
  ctx.textBaseline = 'middle';

  if (!xray) {
    const g = ctx.createLinearGradient(0, 0, TEX_W, TEX_H);
    g.addColorStop(0, '#0f141f');
    g.addColorStop(1, '#161d2b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, TEX_W, TEX_H);
    ctx.fillStyle = tint;
    ctx.globalAlpha = 0.10;
    ctx.fillRect(0, 0, TEX_W, TEX_H);
    ctx.globalAlpha = 1;
  } else {
    ctx.strokeStyle = tint;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1;
    for (let x = 0; x <= TEX_W; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, TEX_H); ctx.stroke(); }
    for (let y = 0; y <= TEX_H; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(TEX_W, y); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }

  // 헤더
  const headH = 104;
  if (!xray) {
    const hg = ctx.createLinearGradient(0, 0, TEX_W, 0);
    hg.addColorStop(0, tint + '38');
    hg.addColorStop(1, '#00000000');
    ctx.fillStyle = hg;
    ctx.fillRect(0, 0, TEX_W, headH);
  }
  ctx.strokeStyle = tint + (xray ? 'cc' : '66');
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(28, headH); ctx.lineTo(TEX_W - 28, headH); ctx.stroke();

  ctx.fillStyle = tint + (xray ? '33' : '2e');
  roundRect(ctx, 30, 26, 54, 54, 14); ctx.fill();
  ctx.strokeStyle = tint + 'aa'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = tint;
  ctx.font = `600 28px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(sec.icon, 57, 55);

  ctx.textAlign = 'left';
  ctx.fillStyle = xray ? tint : '#eef2f9';
  ctx.font = `800 42px ${FONT}`;
  ctx.fillText(sec.name, 104, 54);

  ctx.textAlign = 'right';
  ctx.font = `600 26px ${FONT}`;
  ctx.fillStyle = data.error ? '#ff6b6b' : (xray ? tint : '#8b95a8');
  ctx.fillText(data.error ? '수집 실패' : `${items.length}건`, TEX_W - 32, 54);

  // 행
  const top = headH + 34, rowH = 104;
  if (!items.length) {
    ctx.textAlign = 'left';
    ctx.font = `500 26px ${FONT}`;
    ctx.fillStyle = '#8b95a8';
    ctx.fillText(data.error ? `⚠ ${data.error}` : '데이터 없음', 40, top + 20);
  } else {
    const top6 = items.slice(0, ROWS).map((it, i) => ({ it, i, m: metricOf(sec.key, it, i, items.length) }));
    const max = Math.max(...top6.map((t) => t.m.value), 1);
    for (const { it, i, m } of top6) {
      const y = top + i * rowH + 22;

      ctx.fillStyle = tint + (xray ? '2a' : '33');
      roundRect(ctx, 34, y - 25, 50, 50, 13); ctx.fill();
      ctx.fillStyle = tint;
      ctx.font = `700 26px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), 59, y + 1);

      ctx.textAlign = 'left';
      ctx.fillStyle = xray ? tint : '#e8ecf4';
      ctx.font = `600 32px ${FONT}`;
      ctx.fillText(ellipsize(ctx, it.title || it.keyword || '(제목 없음)', 690), 102, y);

      const barX = TEX_W - 420, barW = 250;
      ctx.fillStyle = tint + '2e';
      roundRect(ctx, barX, y - 6, barW, 12, 6); ctx.fill();
      ctx.fillStyle = tint;
      roundRect(ctx, barX, y - 6, Math.max(14, barW * clamp(m.value / max, 0.06, 1)), 12, 6); ctx.fill();

      ctx.textAlign = 'right';
      ctx.font = `700 28px ${FONT}`;
      ctx.fillStyle = xray ? tint : '#9aa5ba';
      ctx.fillText(m.label, TEX_W - 34, y);
    }
  }

  // 하단: 평소엔 출처 워터마크, 투시일 땐 계측값
  ctx.textAlign = 'left';
  if (xray) {
    ctx.font = `500 21px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = tint;
    ctx.fillText(`src: ${sec.src}   items: ${items.length}   status: ${data.error ? 'ERROR' : 'OK'}   region: ${data.region || '-'}`, 36, TEX_H - 30);
  } else {
    ctx.font = `500 21px ${FONT}`;
    ctx.fillStyle = '#5c6679';
    ctx.fillText(sec.src, 36, TEX_H - 30);
  }
}

// ------------------------------------------------------------- 판 형상 ----
/** 모서리가 둥근 판. cw/ch > 0 이면 +x·+y 쪽 모서리를 L자로 잘라낸다(단면도) */
function plateShape(cw, ch) {
  const x = W / 2, y = H / 2, r = 0.1;
  const s = new THREE.Shape();
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y);
  s.quadraticCurveTo(x, -y, x, -y + r);
  if (cw > 0.001 && ch > 0.001) {
    s.lineTo(x, y - ch);
    s.lineTo(x - cw, y - ch);
    s.lineTo(x - cw, y);
  } else {
    s.lineTo(x, y - r);
    s.quadraticCurveTo(x, y, x - r, y);
  }
  s.lineTo(-x + r, y);
  s.quadraticCurveTo(-x, y, -x, y - r);
  s.lineTo(-x, -y + r);
  s.quadraticCurveTo(-x, -y, -x + r, -y);
  return s;
}

function plateGeometry(cw, ch) {
  const g = new THREE.ExtrudeGeometry(plateShape(cw, ch), {
    depth: T, bevelEnabled: true, bevelSize: 0.014, bevelThickness: 0.014,
    bevelSegments: 2, curveSegments: 10,
  });
  g.translate(0, 0, -T / 2);
  g.rotateX(-Math.PI / 2);            // 판을 눕힌다: 내용 면이 위(+Y)
  return g;
}

// ---------------------------------------------------------------- 뷰어 ----
class Viewer {
  constructor() {
    this.state = {
      mode: 'exploded', xray: false, spin: false,
      spread: 1, cut: 0.5, focus: null,
      az: 0.62, pol: 1.02, dist: 9, zoom: 1,
    };
    this.layers = [];
    this.raf = 0;
    this.open = false;
    this.build();
  }

  // ---------------------------------------------------------- DOM/HUD ----
  build() {
    this.canvas = el('canvas', { class: 'x3-canvas' });
    this.labelBox = el('div', { class: 'x3-labels' });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'x3-lines');
    this.stage = el('div', { class: 'xr-stage x3-stage' }, [this.canvas, this.svg, this.labelBox]);

    const seg = el('div', { class: 'xr-seg' });
    this.modeBtns = [['assembled', '🧱 조립'], ['exploded', '💥 분해도'], ['cutaway', '🔪 단면도']]
      .map(([m, label]) => {
        const b = el('button', { class: 'xr-btn', 'data-mode': m, text: label });
        b.addEventListener('click', () => this.setMode(m));
        seg.appendChild(b);
        return b;
      });

    this.xrayBtn = el('button', { class: 'xr-toggle', text: '🩻 X-ray' });
    this.xrayBtn.addEventListener('click', () => { this.state.xray = !this.state.xray; this.sync(); });

    this.spinBtn = el('button', { class: 'xr-toggle', text: '🔄 자동회전' });
    this.spinBtn.addEventListener('click', () => { this.state.spin = !this.state.spin; this.sync(); });

    this.spreadInput = el('input', { type: 'range', min: '0', max: '100', value: '100' });
    this.spreadInput.addEventListener('input', () => { this.state.spread = this.spreadInput.value / 100; this.sync(); });
    this.spreadWrap = el('label', { class: 'xr-slider' }, [el('span', { text: '분해 간격' }), this.spreadInput]);

    this.cutInput = el('input', { type: 'range', min: '0', max: '100', value: '50' });
    this.cutInput.addEventListener('input', () => { this.state.cut = this.cutInput.value / 100; this.sync(); });
    this.cutWrap = el('label', { class: 'xr-slider', hidden: 'hidden' }, [el('span', { text: '절단 깊이' }), this.cutInput]);

    const reset = el('button', { class: 'xr-toggle', text: '↺ 시점 초기화' });
    reset.addEventListener('click', () => {
      Object.assign(this.state, { az: 0.62, pol: 1.02, zoom: 1, focus: null });
      this.sync();
    });

    const close = el('button', { class: 'xr-close', text: '✕ 닫기' });
    close.addEventListener('click', () => this.hide());

    const hud = el('div', { class: 'xr-hud' }, [
      el('div', { class: 'xr-title' }, [
        el('span', { text: '🧊 3D 해부도' }),
        el('small', { class: 'x3-badge', text: 'WebGL' }),
      ]),
      seg, this.xrayBtn, this.spinBtn, this.spreadWrap, this.cutWrap, reset,
      el('span', { class: 'xr-spacer' }),
      el('span', { class: 'xr-hint', text: '드래그 회전 · 휠 확대 · 판 클릭 시 단독 보기 · 1 2 3 / X / Space / R / Esc' }),
      close,
    ]);

    this.root = el('div', { class: 'xr-overlay x3-overlay', hidden: 'hidden', role: 'dialog', 'aria-label': '트렌드 3D 해부도' },
      [this.stage, hud]);
    document.body.appendChild(this.root);
  }

  // ------------------------------------------------------------ 씬 -------
  initScene() {
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
    this.target = new THREE.Vector3(0, 0, 0);

    // 환경광(반사용) — 캔버스 그라디언트를 PMREM 으로 굽는다
    this.scene.environment = this.makeEnv();

    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(3.5, 7.5, 6.5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 30;
    key.shadow.camera.left = -6; key.shadow.camera.right = 6;
    key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
    key.shadow.bias = -0.0008;
    key.shadow.radius = 3;
    this.scene.add(key);
    this.keyLight = key;

    const rim = new THREE.DirectionalLight(0x66ccff, 0.7);
    rim.position.set(-6, 2.5, -5);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight(0xa9c6ff, 0x0a0d14, 0.18));

    // 접지 그림자 받이
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.ShadowMaterial({ opacity: 0.42 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    // 투시 스캔 판
    this.scan = new THREE.Mesh(
      new THREE.PlaneGeometry(W * 1.5, H * 1.5),
      new THREE.MeshBasicMaterial({
        map: this.makeScanTexture(), color: 0x2af0e6, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    this.scan.rotation.x = -Math.PI / 2;
    this.scan.visible = false;
    this.scene.add(this.scan);

    this.raycaster = new THREE.Raycaster();
    this.buildLayers();
    this.bind();
  }

  /** 가장자리로 갈수록 사라지는 스캔 시트용 텍스처 */
  makeScanTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  makeEnv() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 64);
    g.addColorStop(0, '#7f93c8');
    g.addColorStop(0.45, '#2a3346');
    g.addColorStop(0.55, '#141922');
    g.addColorStop(1, '#05070b');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromEquirectangular(tex).texture;
    pmrem.dispose(); tex.dispose();
    return env;
  }

  buildLayers() {
    for (const [i, sec] of SECTIONS.entries()) {
      const tint = cssVar(sec.varName, '#8899aa');

      const canvas = document.createElement('canvas');
      canvas.width = TEX_W; canvas.height = TEX_H;
      const xcanvas = document.createElement('canvas');
      xcanvas.width = TEX_W; xcanvas.height = TEX_H;

      const mkTex = (cv) => {
        const t = new THREE.CanvasTexture(cv);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        t.repeat.set(1 / W, 1 / H);
        t.offset.set(0.5, 0.5);
        return t;
      };
      const tex = mkTex(canvas), xtex = mkTex(xcanvas);

      // 판의 윗면은 '켜진 화면'처럼 자체발광시켜야 조명·반사에 글자가 묻히지 않는다
      const faceMat = new THREE.MeshPhysicalMaterial({
        map: tex, color: 0x05070c, roughness: 0.95, metalness: 0.0,
        clearcoat: 0.06, clearcoatRoughness: 0.7,
        envMapIntensity: 0.03,
        emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.0,
      });
      const sideMat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(tint), roughness: 0.28, metalness: 0.4,
        envMapIntensity: 0.8,
        emissive: new THREE.Color(tint), emissiveIntensity: 0.4,
      });

      const xFaceMat = new THREE.MeshBasicMaterial({
        map: xtex, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const xSideMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(tint), transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });

      const geo = plateGeometry(0, 0);
      const mesh = new THREE.Mesh(geo, [faceMat, sideMat]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.key = sec.key;

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, 25),
        new THREE.LineBasicMaterial({ color: new THREE.Color(tint), transparent: true, opacity: 0.85 }),
      );
      edges.visible = false;
      mesh.add(edges);

      this.group.add(mesh);

      const label = el('div', { class: 'x3-label' }, [
        el('b', { text: `${sec.icon} ${sec.name}` }),
        el('em', { text: '' }),
      ]);
      label.style.setProperty('--tint', tint);
      this.labelBox.appendChild(label);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('stroke', tint);
      line.setAttribute('stroke-width', '1');
      line.setAttribute('opacity', '0.75');
      this.svg.appendChild(line);

      this.layers.push({
        sec, i, tint, mesh, edges, faceMat, sideMat, xFaceMat, xSideMat, tex, xtex, canvas, xcanvas,
        label, line, y: 0, yTarget: 0, opacity: 1, opacityTarget: 1, cutNow: -1,
      });
    }
  }

  // ------------------------------------------------------------ 입력 -----
  bind() {
    const c = this.canvas;
    let dragging = false, lx = 0, ly = 0, moved = 0, pinch = 0;

    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true; moved = 0; lx = e.clientX; ly = e.clientY;
      this.stage.classList.add('dragging');
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
      this.state.az -= dx * 0.006;
      this.state.pol = clamp(this.state.pol - dy * 0.005, 0.12, 1.52);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      this.stage.classList.remove('dragging');
      try { c.releasePointerCapture(e.pointerId); } catch { /* 이미 해제됨 */ }
      if (moved < 6) this.pick(e);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.state.zoom = clamp(this.state.zoom * (e.deltaY > 0 ? 1.08 : 0.92), 0.45, 2.6);
    }, { passive: false });

    c.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      if (pinch) this.state.zoom = clamp(this.state.zoom * (pinch / d), 0.45, 2.6);
      pinch = d;
    }, { passive: false });
    c.addEventListener('touchend', () => { pinch = 0; });

    this.onKey = (e) => {
      if (!this.open) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') this.hide();
      else if (k === '1') this.setMode('assembled');
      else if (k === '2') this.setMode('exploded');
      else if (k === '3') this.setMode('cutaway');
      else if (k === 'x') { this.state.xray = !this.state.xray; this.sync(); }
      else if (k === ' ') { e.preventDefault(); this.state.spin = !this.state.spin; this.sync(); }
      else if (k === 'r') { Object.assign(this.state, { az: 0.62, pol: 1.02, zoom: 1, focus: null }); this.sync(); }
      else return;
      e.stopPropagation();
    };
    document.addEventListener('keydown', this.onKey);

    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
  }

  pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(p, this.camera);
    const hit = this.raycaster.intersectObjects(this.layers.map((l) => l.mesh), false)[0];
    const key = hit?.object.userData.key || null;
    this.state.focus = this.state.focus === key ? null : key;
    this.sync();
  }

  // ------------------------------------------------------------ 상태 -----
  setMode(mode) {
    this.state.mode = mode;
    if (mode === 'cutaway') this.state.spread = Math.min(this.state.spread, 0.4);
    if (mode === 'exploded' && this.state.spread < 0.2) this.state.spread = 1;
    this.spreadInput.value = Math.round(this.state.spread * 100);
    this.sync();
  }

  sync() {
    const s = this.state;
    const exploded = s.mode === 'exploded';
    const cutaway = s.mode === 'cutaway';

    this.root.classList.toggle('exploded', exploded);
    this.root.classList.toggle('cutaway', cutaway);
    this.root.classList.toggle('xray', s.xray);
    this.xrayBtn.classList.toggle('on', s.xray);
    this.spinBtn.classList.toggle('on', s.spin);
    this.modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.mode === s.mode));
    this.spreadWrap.hidden = s.mode === 'assembled';
    this.cutWrap.hidden = !cutaway;

    const gap = T * 1.25 + (s.mode === 'assembled' ? 0 : 1.15 * s.spread);
    this.layers.forEach((l, i) => {
      l.yTarget = (i - (N - 1) / 2) * gap;
      l.opacityTarget = !s.focus || s.focus === l.sec.key ? 1 : 0.12;

      // 단면: 위쪽 판일수록 더 깊게 잘라 아래 판 속을 드러낸다
      const depth = cutaway ? clamp(s.cut * N - (N - 1 - i), 0, 1) : 0;
      if (Math.abs(depth - l.cutNow) > 0.012) {
        l.cutNow = depth;
        const geo = plateGeometry(W * 0.5 * depth, H * 0.52 * depth);
        l.mesh.geometry.dispose();
        l.mesh.geometry = geo;
        l.edges.geometry.dispose();
        l.edges.geometry = new THREE.EdgesGeometry(geo, 25);
      }

      // 투시 전환: 불투명 재질 ↔ 가산 발광 재질 교체
      l.mesh.material = s.xray ? [l.xFaceMat, l.xSideMat] : [l.faceMat, l.sideMat];

      l.mesh.castShadow = !s.xray;
      l.edges.visible = s.xray || (cutaway && depth > 0.02);
      l.label.classList.toggle('on', exploded);
      l.line.style.display = exploded ? '' : 'none';
    });

    this.floor.visible = !s.xray;
    this.scan.visible = s.xray;
    this.frame();
  }

  /** 스택의 여덟 꼭짓점을 실제로 투영해 화면에 꽉 차는 카메라 거리를 구한다 */
  frame() {
    const yLo = Math.min(...this.layers.map((l) => l.yTarget)) - T / 2;
    const yHi = Math.max(...this.layers.map((l) => l.yTarget)) + T / 2;
    const pts = [];
    for (const x of [-W / 2, W / 2]) for (const z of [-H / 2, H / 2]) for (const y of [yLo, yHi]) {
      pts.push(new THREE.Vector3(x, y, z));
    }

    const cam = this.fitCam || (this.fitCam = this.camera.clone());
    cam.fov = this.camera.fov; cam.aspect = this.camera.aspect;
    const { az, pol } = this.state;
    const labels = this.root.classList.contains('exploded') && innerWidth > 760;
    const fill = labels ? 0.74 : 0.9;                 // 분해도는 오른쪽 라벨 자리를 비워둔다

    let dist = Math.hypot(W, H, yHi - yLo);
    for (let i = 0; i < 5; i++) {
      cam.position.set(dist * Math.sin(pol) * Math.sin(az), dist * Math.cos(pol), dist * Math.sin(pol) * Math.cos(az));
      cam.lookAt(0, 0, 0);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      let mx = 0, my = 0;
      for (const p of pts) {
        const v = p.clone().project(cam);
        mx = Math.max(mx, Math.abs(v.x)); my = Math.max(my, Math.abs(v.y));
      }
      if (!mx || !my) break;
      dist *= Math.max(mx / fill, my / 0.9);
    }
    this.distTarget = dist * this.state.zoom;
    const hFov = 2 * Math.atan(Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect);
    this.panTarget = labels ? this.distTarget * Math.tan(hFov / 2) * 0.26 : 0;
  }

  // ------------------------------------------------------------ 데이터 ---
  fill(payload) {
    const trends = payload?.trends || {};
    for (const l of this.layers) {
      const sec = trends[l.sec.key] || { items: [], error: null };
      const data = { ...sec, region: payload?.region };
      drawPlate(l.canvas, l.sec, data, l.tint, false);
      drawPlate(l.xcanvas, l.sec, data, l.tint, true);
      l.tex.needsUpdate = true;
      l.xtex.needsUpdate = true;
      l.label.querySelector('em').textContent =
        sec.error ? '수집 실패' : `${(sec.items || []).length}건 · ${l.sec.src}`;
    }
  }

  // ------------------------------------------------------------ 루프 -----
  resize() {
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    this.svg.style.width = `${r.width}px`;
    this.svg.style.height = `${r.height}px`;
    this.frame();
  }

  tick(now) {
    this.raf = requestAnimationFrame((t) => this.tick(t));
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    const k = 1 - Math.pow(0.001, dt);            // 프레임레이트 독립 감쇠

    if (this.state.spin) this.state.az += dt * 0.24;
    if (((this.fitTick = (this.fitTick || 0) + 1) % 8) === 0) this.frame();
    this.state.dist = lerp(this.state.dist, this.distTarget, k);

    let lowest = Infinity;
    for (const l of this.layers) {
      l.y = lerp(l.y, l.yTarget, k);
      l.opacity = lerp(l.opacity, l.opacityTarget, k);
      l.mesh.position.y = l.y;
      lowest = Math.min(lowest, l.y);
      const dim = l.opacity < 0.995;
      l.faceMat.transparent = dim; l.faceMat.opacity = l.opacity;
      l.sideMat.transparent = dim; l.sideMat.opacity = l.opacity;
      l.xFaceMat.opacity = 0.95 * l.opacity;
      l.xSideMat.opacity = 0.28 * l.opacity;
      l.edges.material.opacity = 0.85 * l.opacity;
    }

    this.floor.position.y = lowest - T - 0.55;
    this.keyLight.target.position.set(0, 0, 0);

    if (this.state.xray) {
      const t = (now % 3600) / 3600;
      this.scan.position.y = lerp(lowest - 0.4, lowest + (this.layers[N - 1].y - lowest) + 0.6, t);
      this.scan.material.opacity = 0.1 + 0.05 * Math.sin(t * Math.PI);
    }

    const { az, pol, dist } = this.state;
    this.pan = lerp(this.pan || 0, this.panTarget || 0, k);
    const rightX = Math.cos(az), rightZ = -Math.sin(az);          // 카메라 오른쪽 축
    this.target.set(rightX * this.pan, 0, rightZ * this.pan);
    this.camera.position.set(
      this.target.x + dist * Math.sin(pol) * Math.sin(az),
      dist * Math.cos(pol),
      this.target.z + dist * Math.sin(pol) * Math.cos(az),
    );
    this.camera.lookAt(this.target);

    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
  }

  updateLabels() {
    const show = this.root.classList.contains('exploded') && innerWidth > 760;   // 좁은 화면은 라벨 생략
    const r = this.stage.getBoundingClientRect();
    const v = new THREE.Vector3();
    for (const l of this.layers) {
      if (!show || l.opacity < 0.4) { l.label.style.opacity = '0'; l.line.setAttribute('opacity', '0'); continue; }
      v.set(W / 2, l.y, 0).project(this.camera);
      const x = (v.x * 0.5 + 0.5) * r.width;
      const y = (-v.y * 0.5 + 0.5) * r.height;
      const lx = clamp(x + 54, 90, r.width - 20);
      l.label.style.opacity = String(l.opacity);
      l.label.style.transform = `translate(${lx}px, ${y}px) translateY(-50%)`;
      l.line.setAttribute('x1', x); l.line.setAttribute('y1', y);
      l.line.setAttribute('x2', lx - 6); l.line.setAttribute('y2', y);
      l.line.setAttribute('opacity', String(0.7 * l.opacity));
    }
  }

  // ------------------------------------------------------- 열기 / 닫기 ---
  show() {
    if (!this.renderer) this.initScene();
    this.open = true;
    this.root.hidden = false;
    document.body.style.overflow = 'hidden';
    this.fill(window.TrendHub?.getData?.() || null);
    this.unsub = window.TrendHub?.onData?.((d) => this.fill(d)) || null;
    this.resize();
    this.sync();
    this.state.dist = this.distTarget * 1.35;      // 살짝 뒤에서 들어오는 등장 연출
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  hide() {
    this.open = false;
    this.root.hidden = true;
    document.body.style.overflow = '';
    cancelAnimationFrame(this.raf);
    this.unsub?.();
    this.unsub = null;
  }
}

let viewer = null;

export function isOpen() { return !!viewer?.open; }
export function close() { viewer?.hide(); }
export function open() {
  if (!viewer) viewer = new Viewer();
  viewer.show();
}
