'use strict';

const $ = (sel) => document.querySelector(sel);

const PLATFORM_LABEL = {
  youtube: '▶ 유튜브', shorts: '⚡ 쇼츠', tiktok: '🎵 틱톡',
  threads: '@ 스레드', x: '𝕏', etc: '기타', google: '🔍 핫토픽',
};

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

// ------------------------------------------------------------ renderers ----

function renderItem({ title, url, meta, thumb, tall }) {
  const img = thumb ? el('img', { class: `thumb${tall ? ' tall' : ''}`, src: thumb, loading: 'lazy', alt: '' }) : null;
  return el('li', {}, [
    el('a', { class: 'item', href: url, target: '_blank', rel: 'noopener noreferrer' }, [
      img,
      el('div', { class: 'item-body' }, [
        el('div', { class: 'item-title', text: title }),
        meta ? el('div', { class: 'item-meta' }, meta) : null,
      ]),
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

function renderList(key, data) {
  const ol = $(`#list-${key}`);
  if (!ol) return;
  ol.textContent = '';

  if (data.error && !data.items.length) {
    ol.appendChild(el('li', { class: 'error-msg', text: `데이터를 가져오지 못했어요 (${data.error}). 잠시 후 자동 재시도됩니다.` }));
    return;
  }
  if (!data.items.length) {
    ol.appendChild(el('li', { class: 'loading', text: '표시할 항목이 없어요.' }));
    return;
  }

  for (const it of data.items) {
    let li;
    switch (key) {
      case 'google':
        li = renderItem({
          title: it.title, url: it.newsUrl || it.url, thumb: it.image,
          meta: metaSpans([
            it.traffic && { text: `검색 ${it.traffic}`, hot: true },
            it.newsTitle && { text: it.newsTitle },
          ]),
        });
        break;
      case 'youtube':
      case 'shorts':
        li = renderItem({
          title: it.title, url: it.url, thumb: it.thumb,
          meta: metaSpans([
            it.views && { text: it.views, hot: true },
            it.channel && { text: it.channel },
            it.published && { text: it.published },
            it.keyword && { text: `🔥 ${it.keyword}` },
          ]),
        });
        break;
      case 'tiktok':
        li = renderItem({
          title: it.title, url: it.url, thumb: it.thumb, tall: true,
          meta: metaSpans([
            it.plays != null && { text: `재생 ${fmtNum(it.plays)}`, hot: true },
            it.likes != null && { text: `♥ ${fmtNum(it.likes)}` },
            it.author && { text: it.author },
          ]),
        });
        break;
      case 'x':
        li = renderItem({
          title: it.title, url: it.url,
          meta: metaSpans([it.tweets && { text: `게시물 ${fmtNum(it.tweets)}`, hot: true }]),
        });
        break;
      case 'threads':
        li = renderItem({ title: it.title, url: it.url, meta: metaSpans([{ text: '스레드에서 검색 →' }]) });
        break;
    }
    if (li) ol.appendChild(li);
  }
}

function renderTrends(trends, updatedAt) {
  for (const key of ['google', 'youtube', 'shorts', 'tiktok', 'x', 'threads']) {
    renderList(key, trends[key] || { items: [], error: null });
  }
  if (updatedAt) $('#updatedAt').textContent = `갱신 ${fmtTime(updatedAt)}`;
}

function renderPost(post, prepend = false, isNew = false) {
  const ul = $('#list-posts');
  ul.querySelector('.loading')?.remove();
  const li = el('li', { class: isNew ? 'new' : '' }, [
    el('span', { class: 'p-badge', text: PLATFORM_LABEL[post.platform] || post.platform }),
    el('span', { class: 'p-title' }, [
      post.url
        ? el('a', { href: post.url, target: '_blank', rel: 'noopener noreferrer', text: post.title })
        : el('span', { text: post.title }),
    ]),
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
    const res = await fetch('/api/refresh', { method: 'POST' });
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
    const { trends, updatedAt } = JSON.parse(e.data);
    renderTrends(trends, updatedAt);
    toast('트렌드가 갱신됐어요 ✨');
  });
  es.addEventListener('post', (e) => {
    const post = JSON.parse(e.data);
    if (knownPostIds.has(post.id)) return;
    knownPostIds.add(post.id);
    renderPost(post, true, true);
  });
  es.onerror = () => {
    $('#liveDot').classList.remove('on');
    $('#liveText').textContent = '재연결 중…';
  };
}

// ----------------------------------------------------------------- init ----

async function init() {
  connectSSE();
  try {
    const [t, p] = await Promise.all([
      fetch('/api/trends').then((r) => r.json()),
      fetch('/api/posts').then((r) => r.json()),
    ]);
    renderTrends(t.trends, t.updatedAt);
    for (const post of p.posts) {
      knownPostIds.add(post.id);
      renderPost(post);
    }
  } catch {
    toast('초기 데이터를 불러오지 못했어요. 새로고침해 주세요.');
  }
  // 서버가 켜진 직후라면 첫 수집이 끝나기 전일 수 있음 → 잠시 후 한 번 더
  setTimeout(async () => {
    const t = await fetch('/api/trends').then((r) => r.json()).catch(() => null);
    if (t?.updatedAt) renderTrends(t.trends, t.updatedAt);
  }, 6000);
}

init();
