'use strict';

const $ = (sel) => document.querySelector(sel);

let currentRegion = localStorage.getItem('region') || 'KR';
let lastData = null;            // { trends, updatedAt } 마지막 수신본 (검색 재렌더용)
let searchQuery = '';
let reactionCounts = {};        // rkey -> count
const myReactions = new Set(JSON.parse(localStorage.getItem('myReactions') || '[]'));
let favs = JSON.parse(localStorage.getItem('favs') || '[]'); // [키워드]

const PLATFORM_LABEL = {
  youtube: '▶ 유튜브', shorts: '⚡ 쇼츠', tiktok: '🎵 틱톡',
  threads: '@ 스레드', x: '𝕏', etc: '기타', google: '🔍 핫토픽',
};
const CROSS_ICON = { google: '🔍', youtube: '▶', x: '𝕏', tiktok: '🎵' };

// ---------------------------------------------------------------- utils ----

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (v !== null && v !== undefined && v !== '') node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

function fmtNum(n) {
  if (n == null) return '';
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '억';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '만';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + '천';
  return String(n);
}

function fmtTime(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '방금 전';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

let toastTimer;
function toast(msg) {
  document.querySelector('.toast')?.remove();
  document.body.appendChild(el('div', { class: 'toast', text: msg }));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => document.querySelector('.toast')?.remove(), 2500);
}

// ---------------------------------------------------------------- theme ----

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#themeBtn').textContent = theme === 'light' ? '☀️' : '🌙';
  localStorage.setItem('theme', theme);
}
$('#themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});
applyTheme(localStorage.getItem('theme') || 'dark');

// ------------------------------------------------------------- reactions ---

async function react(key, btn) {
  if (myReactions.has(key)) return;
  myReactions.add(key);
  localStorage.setItem('myReactions', JSON.stringify([...myReactions]));
  btn.classList.add('reacted');
  try {
    const res = await fetch('/api/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const j = await res.json();
    if (j.count != null) updateReactionUI(key, j.count);
  } catch { /* 다음 SSE에서 동기화됨 */ }
}

function updateReactionUI(key, count) {
  reactionCounts[key] = count;
  document.querySelectorAll(`[data-rkey="${CSS.escape(key)}"] .react-n`)
    .forEach((n) => { n.textContent = count; });
}

function reactBtn(key) {
  const btn = el('button', {
    class: `act-btn react-btn${myReactions.has(key) ? ' reacted' : ''}`,
    'data-rkey': key, title: '공감',
  }, [
    el('span', { text: '👍' }),
    el('span', { class: 'react-n', text: reactionCounts[key] || '' }),
  ]);
  btn.addEventListener('click', (e) => { e.preventDefault(); react(key, btn); });
  return btn;
}

// ------------------------------------------------------------- favorites ---

function saveFavs() {
  localStorage.setItem('favs', JSON.stringify(favs));
  $('#favCount').textContent = favs.length;
  renderFavs();
}

function toggleFav(keyword) {
  const k = keyword.trim();
  if (favs.includes(k)) favs = favs.filter((f) => f !== k);
  else { favs.unshift(k); if (favs.length > 30) favs.length = 30; }
  saveFavs();
  rerenderTrends(); // 별표 상태 갱신
  toast(favs.includes(k) ? `⭐ "${k}" 즐겨찾기 추가` : `"${k}" 즐겨찾기 해제`);
}

function favBtn(keyword) {
  const on = favs.includes(keyword.trim());
  const btn = el('button', { class: `act-btn fav-btn${on ? ' on' : ''}`, title: '즐겨찾기', text: on ? '★' : '☆' });
  btn.addEventListener('click', (e) => { e.preventDefault(); toggleFav(keyword); });
  return btn;
}

const FAV_LINKS = (k) => [
  ['🔍', `https://www.google.com/search?q=${encodeURIComponent(k)}`],
  ['▶', `https://www.youtube.com/results?search_query=${encodeURIComponent(k)}`],
  ['🎵', `https://www.tiktok.com/search?q=${encodeURIComponent(k)}`],
  ['𝕏', `https://x.com/search?q=${encodeURIComponent(k)}`],
  ['@', `https://www.threads.net/search?q=${encodeURIComponent(k)}&serp_type=default`],
];

function renderFavs() {
  const ol = $('#list-favs');
  ol.textContent = '';
  if (!favs.length) {
    ol.appendChild(el('li', { class: 'loading', text: '트렌드 옆의 ☆ 를 눌러 즐겨찾기에 담아보세요.' }));
    return;
  }
  for (const k of favs) {
    const del = el('button', { class: 'act-btn fav-del', title: '삭제', text: '✕' });
    del.addEventListener('click', () => toggleFav(k));
    ol.appendChild(el('li', { class: 'fav-row' }, [
      el('span', { class: 'fav-kw', text: `⭐ ${k}` }),
      el('span', { class: 'fav-links' },
        FAV_LINKS(k).map(([icon, url]) =>
          el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'fav-link', text: icon }))),
      del,
    ]));
  }
}

// ---------------------------------------------------------------- share ----

function shareBtn(title, url) {
  const btn = el('button', { class: 'act-btn', title: '공유', text: '↗' });
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const text = `🔥 지금 뜨는: ${title}`;
    try {
      if (navigator.share) await navigator.share({ title: 'TrendHub', text, url });
      else { await navigator.clipboard.writeText(`${text}\n${url}`); toast('링크를 복사했어요 📋'); }
    } catch { /* 사용자가 공유 취소 */ }
  });
  return btn;
}

// ------------------------------------------------------------ renderers ----

function deltaBadge(rankDelta) {
  if (rankDelta === 'new') return el('span', { class: 'badge badge-new', text: 'NEW' });
  if (typeof rankDelta === 'number' && rankDelta > 0)
    return el('span', { class: 'badge badge-up', text: `▲${rankDelta}` });
  if (typeof rankDelta === 'number' && rankDelta < 0)
    return el('span', { class: 'badge badge-down', text: `▼${-rankDelta}` });
  return null;
}

function crossBadge(cross) {
  if (!cross) return null;
  const icons = cross.map((p) => CROSS_ICON[p] || '').join('');
  return el('span', { class: 'badge badge-cross', title: `${cross.length}개 플랫폼 동시 등장`, text: `🌐 ${icons}` });
}

function renderItem(it, { title, url, meta, thumb, tall, favKeyword }) {
  const img = thumb ? el('img', { class: `thumb${tall ? ' tall' : ''}`, src: thumb, loading: 'lazy', alt: '' }) : null;
  const badges = [deltaBadge(it.rankDelta), crossBadge(it.cross)].filter(Boolean);
  return el('li', {}, [
    el('a', { class: 'item', href: url, target: '_blank', rel: 'noopener noreferrer' }, [
      img,
      el('div', { class: 'item-body' }, [
        el('div', { class: 'item-title' }, [
          ...badges,
          el('span', { text: title }),
        ]),
        meta ? el('div', { class: 'item-meta' }, meta) : null,
      ]),
    ]),
    el('div', { class: 'item-actions' }, [
      favKeyword ? favBtn(favKeyword) : null,
      it.rkey ? reactBtn(it.rkey) : null,
      shareBtn(title, url),
    ]),
  ]);
}

function metaSpans(parts) {
  return parts.filter(Boolean).map((p, i) => {
    const span = el('span', { text: (i > 0 ? ' · ' : '') + p.text });
    if (p.hot) span.classList.add('hot');
    return span;
  });
}

function matchesSearch(it, key) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return [it.title, it.keyword, it.channel, it.author, it.newsTitle]
    .some((f) => f && String(f).toLowerCase().includes(q));
}

function renderList(key, data) {
  const ol = $(`#list-${key}`);
  if (!ol) return;
  ol.textContent = '';

  if (data.error && !data.items.length) {
    ol.appendChild(el('li', { class: 'error-msg', text: `데이터를 가져오지 못했어요 (${data.error}). 잠시 후 자동 재시도됩니다.` }));
    return;
  }

  const items = data.items.filter((it) => matchesSearch(it, key));
  if (!items.length) {
    ol.appendChild(el('li', {
      class: 'loading',
      text: searchQuery ? `"${searchQuery}" 검색 결과가 없어요.` : '표시할 항목이 없어요.',
    }));
    return;
  }

  for (const it of items) {
    let li;
    switch (key) {
      case 'google':
        li = renderItem(it, {
          title: it.title, url: it.newsUrl || it.url, thumb: it.image, favKeyword: it.title,
          meta: metaSpans([
            it.traffic && { text: `검색 ${it.traffic}`, hot: true },
            it.newsTitle && { text: it.newsTitle },
          ]),
        });
        break;
      case 'youtube':
      case 'shorts':
        li = renderItem(it, {
          title: it.title, url: it.url, thumb: it.thumb, favKeyword: it.keyword,
          meta: metaSpans([
            it.views && { text: it.views, hot: true },
            it.channel && { text: it.channel },
            it.published && { text: it.published },
            it.keyword && { text: `🔥 ${it.keyword}` },
          ]),
        });
        break;
      case 'tiktok':
        li = renderItem(it, {
          title: it.title, url: it.url, thumb: it.thumb, tall: true,
          meta: metaSpans([
            it.plays != null && { text: `재생 ${fmtNum(it.plays)}`, hot: true },
            it.likes != null && { text: `♥ ${fmtNum(it.likes)}` },
            it.author && { text: it.author },
          ]),
        });
        break;
      case 'x':
        li = renderItem(it, {
          title: it.title, url: it.url, favKeyword: it.title,
          meta: metaSpans([it.tweets && { text: `게시물 ${fmtNum(it.tweets)}`, hot: true }]),
        });
        break;
      case 'threads':
        li = renderItem(it, {
          title: it.title, url: it.url, favKeyword: it.title,
          meta: metaSpans([{ text: '스레드에서 검색 →' }]),
        });
        break;
    }
    if (li) ol.appendChild(li);
  }
}

function renderTrends(trends, updatedAt) {
  for (const key of ['google', 'youtube', 'shorts', 'tiktok', 'x', 'threads']) {
    renderList(key, trends[key] || { items: [], error: null });
  }
  $('#updatedAt').textContent = updatedAt ? `갱신 ${fmtTime(updatedAt)}` : '수집 중…';
}

function rerenderTrends() {
  if (lastData) renderTrends(lastData.trends, lastData.updatedAt);
}

function acceptData(t) {
  lastData = { trends: t.trends, updatedAt: t.updatedAt, region: t.region || currentRegion };
  if (t.reactions) reactionCounts = { ...reactionCounts, ...t.reactions };
  renderTrends(t.trends, t.updatedAt);
  for (const fn of dataListeners) { try { fn(lastData); } catch { /* 구독자 오류는 무시 */ } }
}

// 3D 해부도(xray.js) 등 부가 뷰가 붙을 수 있는 최소 브리지
const dataListeners = new Set();
window.TrendHub = {
  getData: () => lastData,
  onData(fn) { dataListeners.add(fn); return () => dataListeners.delete(fn); },
};

// --------------------------------------------------------------- search ----

let searchTimer;
$('#searchBox').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = e.target.value.trim();
    $('#searchClear').classList.toggle('hidden', !searchQuery);
    rerenderTrends();
  }, 200);
});
$('#searchClear').addEventListener('click', () => {
  $('#searchBox').value = '';
  searchQuery = '';
  $('#searchClear').classList.add('hidden');
  rerenderTrends();
});

// --------------------------------------------------------------- region ----

async function loadRegion(region) {
  currentRegion = region;
  localStorage.setItem('region', region);
  document.querySelectorAll('.region').forEach((b) =>
    b.classList.toggle('active', b.dataset.region === region));
  document.querySelectorAll('.list:not(.posts):not(#list-favs)').forEach((ol) => {
    ol.textContent = '';
    ol.appendChild(el('li', { class: 'loading', text: '불러오는 중…' }));
  });
  const t = await fetch(`/api/trends?region=${region}`).then((r) => r.json()).catch(() => null);
  if (t && t.region === currentRegion) acceptData(t);
}

$('#regionSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('.region');
  if (btn && btn.dataset.region !== currentRegion) loadRegion(btn.dataset.region);
});

// ---------------------------------------------------------------- posts ----

function renderPost(post, prepend = false, isNew = false) {
  const ul = $('#list-posts');
  ul.querySelector('.loading')?.remove();
  const rkey = `post:${post.id}`;
  const li = el('li', { class: isNew ? 'new' : '' }, [
    el('span', { class: 'p-badge', text: PLATFORM_LABEL[post.platform] || post.platform }),
    el('span', { class: 'p-title' }, [
      post.url
        ? el('a', { href: post.url, target: '_blank', rel: 'noopener noreferrer', text: post.title })
        : el('span', { text: post.title }),
    ]),
    reactBtn(rkey),
    el('span', { class: 'p-meta', text: `${post.nick} · ${fmtTime(post.time)}` }),
  ]);
  prepend ? ul.prepend(li) : ul.appendChild(li);
}

// ----------------------------------------------------------------- tabs ----

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  const tab = btn.dataset.tab;
  document.querySelectorAll('.card').forEach((c) => {
    c.classList.toggle('hidden', tab !== 'all' && c.dataset.platform !== tab);
  });
});

// ---------------------------------------------------------------- share ----

$('#shareForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    nick: $('#fNick').value,
    platform: $('#fPlatform').value,
    title: $('#fTitle').value,
    url: $('#fUrl').value,
  };
  try {
    const res = await fetch('/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) return toast(json.error || '공유에 실패했어요.');
    $('#fTitle').value = '';
    $('#fUrl').value = '';
    toast('공유 완료! 모든 접속자에게 실시간으로 전달됐어요.');
  } catch {
    toast('네트워크 오류가 발생했어요.');
  }
});

// -------------------------------------------------------------- refresh ----

$('#refreshBtn').addEventListener('click', async () => {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/refresh?region=${currentRegion}`, { method: 'POST' });
    const json = await res.json();
    toast(res.ok ? '트렌드를 새로 가져오는 중…' : json.error);
  } catch {
    toast('네트워크 오류가 발생했어요.');
  }
  setTimeout(() => { btn.disabled = false; }, 5000);
});

// ------------------------------------------------------------- realtime ----

const knownPostIds = new Set();

function connectSSE() {
  const es = new EventSource('/api/stream');
  es.addEventListener('hello', () => {
    $('#liveDot').classList.add('on');
    $('#liveText').textContent = 'LIVE';
  });
  es.addEventListener('clients', (e) => {
    $('#viewerCount').textContent = JSON.parse(e.data).count;
  });
  es.addEventListener('trends', (e) => {
    const data = JSON.parse(e.data);
    if (data.region !== currentRegion) return;
    acceptData(data);
    toast('트렌드가 갱신됐어요 ✨');
  });
  es.addEventListener('post', (e) => {
    const post = JSON.parse(e.data);
    if (knownPostIds.has(post.id)) return;
    knownPostIds.add(post.id);
    renderPost(post, true, true);
  });
  es.addEventListener('react', (e) => {
    const { key, count } = JSON.parse(e.data);
    updateReactionUI(key, count);
  });
  es.onerror = () => {
    $('#liveDot').classList.remove('on');
    $('#liveText').textContent = '재연결 중…';
  };
}

// ----------------------------------------------------------------- init ----

async function init() {
  connectSSE();
  document.querySelectorAll('.region').forEach((b) =>
    b.classList.toggle('active', b.dataset.region === currentRegion));
  $('#favCount').textContent = favs.length;
  renderFavs();
  try {
    const [t, p] = await Promise.all([
      fetch(`/api/trends?region=${currentRegion}`).then((r) => r.json()),
      fetch('/api/posts').then((r) => r.json()),
    ]);
    if (p.reactions) reactionCounts = { ...reactionCounts, ...p.reactions };
    acceptData(t);
    for (const post of p.posts) {
      knownPostIds.add(post.id);
      renderPost(post);
    }
  } catch {
    toast('초기 데이터를 불러오지 못했어요. 새로고침해 주세요.');
  }
  // 서버가 켜진 직후라면 해당 지역 첫 수집이 끝나기 전일 수 있음 → 잠시 후 한 번 더
  setTimeout(async () => {
    const t = await fetch(`/api/trends?region=${currentRegion}`).then((r) => r.json()).catch(() => null);
    if (t?.updatedAt && t.region === currentRegion) acceptData(t);
  }, 8000);
}

init();

// PWA: 서비스워커 등록 (홈 화면 설치 + 오프라인 셸)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
