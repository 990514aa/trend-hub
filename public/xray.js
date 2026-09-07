/* ================================================================
   TrendHub 3D 해부도 (Exploded view · X-ray · Cutaway)
   - 외부 라이브러리 0개. CSS 3D transform + clip-path 로만 구현.
   - 6개 트렌드 섹션을 "적층 기판"으로 보고 분해/투시/절단해 보여준다.
   ================================================================ */
'use strict';

(() => {
  const SECTIONS = [
    { key: 'google',  icon: '🔍', name: '실시간 핫토픽', src: 'trends.google.com/trending/rss', tint: '--google' },
    { key: 'youtube', icon: '▶',  name: '유튜브 인기',   src: 'youtubei/v1/search',            tint: '--youtube' },
    { key: 'shorts',  icon: '⚡', name: '쇼츠 트렌딩',   src: 'shortsLockupViewModel',          tint: '--shorts' },
    { key: 'tiktok',  icon: '🎵', name: '틱톡 인기 영상', src: 'tikwm.com/api/feed/list',       tint: '--tiktok' },
    { key: 'x',       icon: '𝕏',  name: 'X 실시간 트렌드', src: 'trends24.in',                 tint: '--x' },
    { key: 'threads', icon: '@',  name: '스레드 핫키워드', src: '핫키워드 → 검색 링크',          tint: '--threads' },
  ];
  const ROWS = 5;

  const state = {
    open: false,
    mode: 'exploded',      // assembled | exploded | cutaway
    xray: false,
    spin: false,
    spread: 1,             // 분해 간격 배율 (0 ~ 1)
    cut: 0.5,              // 절단 깊이 (0 ~ 1)
    rx: 58, rz: -34, zoom: 1,
    focus: null,
  };

  let root, deck, stage, layers = [], hud = {}, rafId = 0, fitId = 0, unsub = null;
  const view = { fit: 1, panX: 0, panY: 0 };   // 자동 프레이밍 결과(사용자 줌과 별개)

  // ------------------------------------------------------------- utils ---
  const el = (tag, attrs = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') n.textContent = v;
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
    }
    for (const c of kids) if (c) n.appendChild(c);
    return n;
  };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /** "조회수 1.2만회", "1,234", "12K", "3.4M" → 숫자 (실패 시 null) */
  function parseMetric(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (!v) return null;
    const s = String(v).replace(/,/g, '');
    const m = s.match(/(\d+(?:\.\d+)?)\s*([억만천KMB천]?)/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = (m[2] || '').toUpperCase();
    const mul = { '억': 1e8, '만': 1e4, '천': 1e3, K: 1e3, M: 1e6, B: 1e9 }[unit] || 1;
    return n * mul;
  }

  function fmtNum(n) {
    if (n == null) return '';
    if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '억';
    if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '만';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + '천';
    return String(Math.round(n));
  }

  /** 섹션별 대표 수치 뽑기 — 없으면 순위 기반 가중치로 대체 */
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

  // ------------------------------------------------------------- build ---
  function buildLayer(sec, i) {
    const layer = el('div', {
      class: 'xr-layer', 'data-platform': sec.key,
      style: `--i:${i - (SECTIONS.length - 1) / 2}; --tint-solid: var(${sec.tint});` +
             `--tint: color-mix(in srgb, var(${sec.tint}) 45%, transparent);` +
             `--tint-weak: color-mix(in srgb, var(${sec.tint}) 14%, transparent);`,
    });

    for (let s = 1; s <= 5; s++) layer.appendChild(el('div', { class: 'xr-slab', style: `--s:${s}` }));

    const rows = el('div', { class: 'xr-rows' });
    const count = el('span', { class: 'xr-count', text: '…' });
    const internals = el('div', { class: 'xr-internals' });

    const plate = el('div', { class: 'xr-plate' }, [
      el('div', { class: 'xr-head' }, [
        el('span', { class: 'xr-chip', text: sec.icon }),
        el('b', { text: sec.name }),
        count,
      ]),
      rows,
      internals,
    ]);

    const callout = el('div', { class: 'xr-callout' }, [
      el('span', {}, [
        el('i', { style: 'font-style:normal', text: `${sec.icon} ${sec.name}` }),
        el('em', { class: 'xr-cal-meta', text: '' }),
      ]),
    ]);

    layer.append(
      plate,
      el('div', { class: 'xr-grid' }),
      el('div', { class: 'xr-cut' }, [el('i', { class: 'v' }), el('i', { class: 'h' })]),
      callout,
    );

    return { sec, node: layer, plate, rows, count, internals, callout };
  }

  function buildUI() {
    stage = el('div', { class: 'xr-stage' });
    deck = el('div', { class: 'xr-deck' });
    layers = SECTIONS.map(buildLayer);
    for (const l of layers) deck.appendChild(l.node);
    stage.append(deck, el('div', { class: 'xr-scan' }));

    const seg = el('div', { class: 'xr-seg' });
    hud.modeBtns = [
      ['assembled', '🧱 조립'],
      ['exploded', '💥 분해도'],
      ['cutaway', '🔪 단면도'],
    ].map(([m, label]) => {
      const b = el('button', { class: 'xr-btn', 'data-mode': m, text: label });
      b.addEventListener('click', () => setMode(m));
      seg.appendChild(b);
      return b;
    });

    hud.xrayBtn = el('button', { class: 'xr-toggle', text: '🩻 X-ray' });
    hud.xrayBtn.addEventListener('click', () => { state.xray = !state.xray; apply(); });

    hud.spinBtn = el('button', { class: 'xr-toggle', text: '🔄 자동회전' });
    hud.spinBtn.addEventListener('click', () => { state.spin = !state.spin; apply(); spinLoop(); });

    hud.spreadWrap = el('label', { class: 'xr-slider' }, [
      el('span', { text: '분해 간격' }),
      hud.spread = el('input', { type: 'range', min: '0', max: '100', value: '100' }),
    ]);
    hud.spread.addEventListener('input', () => { state.spread = hud.spread.value / 100; apply(); });

    hud.cutWrap = el('label', { class: 'xr-slider', hidden: 'hidden' }, [
      el('span', { text: '절단 깊이' }),
      hud.cut = el('input', { type: 'range', min: '0', max: '100', value: '50' }),
    ]);
    hud.cut.addEventListener('input', () => { state.cut = hud.cut.value / 100; apply(); });

    const resetBtn = el('button', { class: 'xr-toggle', text: '↺ 시점 초기화' });
    resetBtn.addEventListener('click', () => {
      Object.assign(state, { rx: 58, rz: -34, zoom: 1 });
      Object.assign(view, { fit: 1, panX: 0, panY: 0 });
      deck.classList.remove('free');
      apply();
    });

    const closeBtn = el('button', { class: 'xr-close', text: '✕ 닫기' });
    closeBtn.addEventListener('click', close);

    const bar = el('div', { class: 'xr-hud' }, [
      el('div', { class: 'xr-title' }, [
        el('span', { text: '🧊 3D 해부도' }),
        el('small', { text: '드래그 회전 · 휠 확대 · 레이어 클릭 시 단독 보기' }),
      ]),
      seg, hud.xrayBtn, hud.spinBtn, hud.spreadWrap, hud.cutWrap, resetBtn,
      el('span', { class: 'xr-spacer' }),
      el('span', { class: 'xr-hint', text: '1 2 3 모드 · X 투시 · Space 회전 · R 초기화 · Esc 닫기' }),
      closeBtn,
    ]);

    root = el('div', { class: 'xr-overlay', hidden: 'hidden', role: 'dialog', 'aria-label': '트렌드 3D 해부도' }, [stage, bar]);
    document.body.appendChild(root);

    bindPointer();
  }

  // ---------------------------------------------------------- 상호작용 ---
  function bindPointer() {
    let dragging = false, lx = 0, ly = 0, moved = 0, pinch = 0;

    stage.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true; moved = 0; lx = e.clientX; ly = e.clientY;
      deck.classList.add('free'); stage.classList.add('dragging');
      stage.setPointerCapture(e.pointerId);
    });

    stage.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
      state.rz -= dx * 0.35;
      state.rx = clamp(state.rx + dy * 0.3, 5, 88);
      applyDeck();
      reframe();
    });

    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      stage.classList.remove('dragging');
      try { stage.releasePointerCapture(e.pointerId); } catch { /* 이미 해제됨 */ }
      if (moved < 6) handleTap(e);
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);

    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.zoom = clamp(state.zoom * (e.deltaY > 0 ? 0.92 : 1.08), 0.35, 2.4);
      deck.classList.add('free');
      applyDeck();
      if (state.zoom <= 1) reframe();
    }, { passive: false });

    // 두 손가락 확대 (모바일)
    stage.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      if (pinch) { state.zoom = clamp(state.zoom * (d / pinch), 0.35, 2.4); applyDeck(); }
      pinch = d;
    }, { passive: false });
    stage.addEventListener('touchend', () => { pinch = 0; });

    window.addEventListener('resize', () => { if (state.open) settle(); });

    document.addEventListener('keydown', (e) => {
      if (!state.open) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') close();
      else if (k === '1') setMode('assembled');
      else if (k === '2') setMode('exploded');
      else if (k === '3') setMode('cutaway');
      else if (k === 'x') { state.xray = !state.xray; apply(); }
      else if (k === ' ') { e.preventDefault(); state.spin = !state.spin; apply(); spinLoop(); }
      else if (k === 'r') {
        Object.assign(state, { rx: 58, rz: -34, zoom: 1 });
        Object.assign(view, { fit: 1, panX: 0, panY: 0 });
        deck.classList.remove('free');
        apply();
      }
      else return;
      e.stopPropagation();
    });
  }

  /** 레이어를 탭하면 그 레이어만 남기고 나머지는 흐려진다
      (드래그용 포인터 캡처 때문에 e.target 은 무대가 되므로 좌표로 다시 찾는다) */
  function handleTap(e) {
    const node = document.elementFromPoint(e.clientX, e.clientY)?.closest('.xr-layer');
    const key = node?.dataset.platform || null;
    state.focus = state.focus === key ? null : key;
    apply();
  }

  function setMode(mode) {
    state.mode = mode;
    if (mode === 'cutaway') state.spread = Math.min(state.spread, 0.45);
    if (mode === 'exploded' && state.spread < 0.2) state.spread = 1;
    hud.spread.value = Math.round(state.spread * 100);
    apply();
  }

  let spinTick = 0;
  function spinLoop() {
    cancelAnimationFrame(rafId);
    if (!state.spin || !state.open) return;
    const step = () => {
      state.rz -= 0.22;
      deck.classList.add('free');
      applyDeck();
      if ((spinTick = (spinTick + 1) % 6) === 0) reframe();
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------ 렌더 ----
  /** 실제로 그려진 화면 상자를 재서 스택이 무대에 꽉 차게 배율·위치를 보정한다 */
  function measure() {
    const sr = stage.getBoundingClientRect();
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    const withCallout = root.classList.contains('exploded');
    for (const la of layers) {
      for (const n of withCallout ? [la.node, la.callout] : [la.node]) {
        const q = n.getBoundingClientRect();
        if (!q.width || !q.height) continue;
        l = Math.min(l, q.left); t = Math.min(t, q.top);
        r = Math.max(r, q.right); b = Math.max(b, q.bottom);
      }
    }
    return { sr, w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
  }

  function reframe() {
    if (!state.open) return false;
    const m = measure();
    if (!Number.isFinite(m.w) || m.w <= 0 || !m.sr.height) return false;
    let moved = false;

    const f = Math.min(m.sr.width * 0.94 / m.w, m.sr.height * 0.92 / m.h);
    if (f < 0.98 || f > 1.05) {
      view.fit = clamp(view.fit * (1 + (f - 1) * 0.6), 0.12, 1.25);
      moved = true;
    }
    const dx = m.sr.left + m.sr.width / 2 - m.cx;
    const dy = m.sr.top + m.sr.height / 2 - m.cy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      view.panX += dx * 0.6; view.panY += dy * 0.6;
      moved = true;
    }
    if (moved) applyDeck();
    return moved;
  }

  /** 전환 애니메이션이 끝날 때까지 몇 프레임 따라가며 프레이밍을 다듬는다 */
  function settle(frames = 45) {
    cancelAnimationFrame(fitId);
    let n = frames, calm = 0;
    const step = () => {
      const moved = reframe();
      calm = moved ? 0 : calm + 1;
      if (--n > 0 && calm < 4) fitId = requestAnimationFrame(step);
    };
    fitId = requestAnimationFrame(step);
  }

  function applyDeck() {
    deck.style.setProperty('--rx', `${state.rx}deg`);
    deck.style.setProperty('--rz', `${state.rz}deg`);
    deck.style.setProperty('--pan-x', `${view.panX.toFixed(1)}px`);
    deck.style.setProperty('--pan-y', `${view.panY.toFixed(1)}px`);
    deck.style.setProperty('--zoom', (state.zoom * view.fit).toFixed(3));
    // 콜아웃 라벨이 항상 카메라를 향하도록 역회전 값을 내려보낸다
    deck.style.setProperty('--crz', `${-state.rz}deg`);
    deck.style.setProperty('--crx', `${-state.rx}deg`);
  }

  function apply() {
    if (!root) return;
    const exploded = state.mode === 'exploded';
    const cutaway = state.mode === 'cutaway';

    root.classList.toggle('exploded', exploded);
    root.classList.toggle('cutaway', cutaway);
    root.classList.toggle('xray', state.xray);
    hud.xrayBtn.classList.toggle('on', state.xray);
    hud.spinBtn.classList.toggle('on', state.spin);
    hud.modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
    hud.spreadWrap.hidden = state.mode === 'assembled';
    hud.cutWrap.hidden = !cutaway;

    const gap = state.mode === 'assembled' ? 14 : 14 + 150 * state.spread;
    deck.style.setProperty('--gap', `${gap}px`);
    deck.style.setProperty('--dolly', `${-60 - gap * 1.2}px`);

    layers.forEach((l, i) => {
      l.node.classList.toggle('dimmed', !!state.focus && state.focus !== l.sec.key);

      // Cutaway: 위쪽 레이어부터 모서리를 잘라내 아래 레이어 내부를 드러낸다
      const depth = clamp(state.cut * SECTIONS.length - (SECTIONS.length - 1 - i), 0, 1);
      const on = cutaway && depth > 0.02;
      l.node.classList.toggle('cut', on);
      if (on) {
        const w = (100 - 58 * depth).toFixed(1);   // 남기는 가로 폭
        const h = (18 + 62 * depth).toFixed(1);    // 잘라내는 세로 높이
        l.node.style.setProperty('--clip',
          `polygon(0 0, ${w}% 0, ${w}% ${h}%, 100% ${h}%, 100% 100%, 0 100%)`);
        l.node.style.setProperty('--cw', `${w}%`);
        l.node.style.setProperty('--ch', `${h}%`);
      } else {
        l.node.style.setProperty('--clip', 'none');
      }
    });

    applyDeck();
    settle();
  }

  // ------------------------------------------------------------ 데이터 ---
  function fill(data) {
    if (!root) return;
    const trends = data?.trends || {};
    for (const l of layers) {
      const sec = trends[l.sec.key] || { items: [], error: null };
      const items = sec.items || [];
      l.count.textContent = sec.error ? '수집 실패' : `${items.length}건`;

      l.rows.textContent = '';
      if (!items.length) {
        l.rows.appendChild(el('div', { class: 'xr-empty', text: sec.error ? `⚠ ${sec.error}` : '데이터 없음' }));
      } else {
        const top = items.slice(0, ROWS).map((it, i) => ({ it, i, m: metricOf(l.sec.key, it, i, items.length) }));
        const max = Math.max(...top.map((t) => t.m.value), 1);
        for (const { it, i, m } of top) {
          l.rows.appendChild(el('div', { class: 'xr-row' }, [
            el('span', { class: 'xr-rank', text: String(i + 1) }),
            el('span', { class: 'xr-t', text: it.title || it.keyword || '(제목 없음)' }),
            el('span', { class: 'xr-bar' }, [el('i', { style: `--p:${clamp(m.value / max * 100, 6, 100).toFixed(1)}%` })]),
            el('span', { class: 'xr-v', text: m.label }),
          ]));
        }
      }

      l.internals.textContent = '';
      for (const t of [
        `src: ${l.sec.src}`,
        `items: ${items.length}`,
        `status: ${sec.error ? 'ERROR' : 'OK'}`,
        `region: ${data?.region || '-'}`,
      ]) l.internals.appendChild(el('code', { text: t }));

      l.callout.querySelector('.xr-cal-meta').textContent =
        sec.error ? '수집 실패' : `${items.length}건 · ${l.sec.src}`;
    }
  }

  function refresh() {
    fill(window.TrendHub?.getData?.() || null);
  }

  // ------------------------------------------------------ open / close ---
  function open() {
    if (!root) buildUI();
    state.open = true;
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    refresh();
    apply();
    spinLoop();
    unsub = window.TrendHub?.onData?.(fill) || null;
  }

  function close() {
    state.open = false;
    root.hidden = true;
    document.body.style.overflow = '';
    cancelAnimationFrame(rafId);
    cancelAnimationFrame(fitId);
    unsub?.();
    unsub = null;
  }

  document.getElementById('xrayBtn')?.addEventListener('click', () => (state.open ? close() : open()));

  window.TrendHubXray = { open, close, setMode };
})();
