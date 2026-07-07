/**
 * TrendHub — SNS 트렌드 통합 대시보드 서버
 *
 * 외부 npm 의존성 0개, Node.js 18+ 내장 모듈만 사용.
 * 플랫폼 로그인/API 키 없이 공개 엔드포인트만 수집:
 *   - Google Trends 공식 RSS (핫토픽)
 *   - YouTube 트렌딩 페이지 (영상 + 쇼츠)
 *   - trends24.in (X/트위터 실시간 트렌드)
 *   - tikwm.com 공개 피드 (틱톡 인기 영상)
 *   - Threads: 무키 공개 소스가 없어 핫키워드 검색 링크로 대체
 *
 * 실시간: SSE(/api/stream)로 트렌드 갱신·커뮤니티 공유를 모든 접속자에게 브로드캐스트.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4173;
const REFRESH_MS = 10 * 60 * 1000;        // 자동 갱신 주기 10분
const MANUAL_REFRESH_COOLDOWN = 60 * 1000; // 수동 새로고침 최소 간격
const DATA_DIR = path.join(__dirname, 'data');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// ---------------------------------------------------------------- state ----

const state = {
  trends: {
    google: { items: [], error: null },
    youtube: { items: [], error: null },
    shorts: { items: [], error: null },
    tiktok: { items: [], error: null },
    x: { items: [], error: null },
    threads: { items: [], error: null },
  },
  updatedAt: null,
  refreshing: false,
};
let lastManualRefresh = 0;

let posts = [];
try {
  posts = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8'));
  if (!Array.isArray(posts)) posts = [];
} catch { posts = []; }

function savePosts() {
  fs.mkdir(DATA_DIR, { recursive: true }, () => {
    fs.writeFile(POSTS_FILE, JSON.stringify(posts, null, 1), () => {});
  });
}

// ------------------------------------------------------------------ SSE ----

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ------------------------------------------------------------- fetchers ----

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8', ...headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

// 구글 트렌드 공식 RSS — 실시간 급상승 검색어
async function fetchGoogleTrends() {
  const xml = await fetchText('https://trends.google.com/trending/rss?geo=KR');
  const items = [];
  for (const chunk of xml.split('<item>').slice(1)) {
    const pick = (tag) => {
      const m = chunk.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return m ? decodeEntities(m[1].trim()) : '';
    };
    const title = pick('title');
    if (!title) continue;
    items.push({
      title,
      traffic: pick('ht:approx_traffic'),
      newsTitle: pick('ht:news_item_title'),
      newsUrl: pick('ht:news_item_url'),
      image: pick('ht:picture'),
      url: `https://www.google.com/search?q=${encodeURIComponent(title)}`,
    });
    if (items.length >= 20) break;
  }
  return items;
}

// 유튜브 내부 검색 API (페이지에 공개된 엔드포인트, 별도 API 키 발급 불필요)
// 참고: 유튜브가 2025년 '인기 급상승' 페이지를 폐지해서, 핫토픽 키워드별로
// "이번 주 조회수순" 검색을 돌려 실제 많이 본 영상을 모으는 방식을 사용.
const YT_SORT_VIEWS_WEEK = 'CAMSBAgDEAE='; // 정렬:조회수, 업로드:이번주, 유형:영상

// '조회수 6.2천회' / '2.7만회' / '1.2억회' → 숫자
function parseKoViews(text) {
  const m = String(text || '').match(/([\d.,]+)\s*(천|만|억)?/);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  const mult = { '천': 1e3, '만': 1e4, '억': 1e8 }[m[2]] || 1;
  return Math.round(n * mult);
}

async function ytSearch(query, params) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: '2.20260706.00.00', gl: 'KR', hl: 'ko' } },
      query, params,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const videos = [];
  const shorts = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    const v = node.videoRenderer;
    if (v && v.videoId) {
      const viewsText = v.viewCountText?.simpleText || '';
      videos.push({
        id: v.videoId,
        title: v.title?.runs?.[0]?.text || '',
        views: viewsText,
        viewsNum: parseInt(viewsText.replace(/[^\d]/g, ''), 10) || 0,
        channel: v.ownerText?.runs?.[0]?.text || '',
        published: v.publishedTimeText?.simpleText || '',
        thumb: v.thumbnail?.thumbnails?.[0]?.url || '',
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
      });
    }
    const s = node.shortsLockupViewModel;
    if (s) {
      const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
      const viewsText = s.overlayMetadata?.secondaryText?.content || '';
      if (id) {
        shorts.push({
          id,
          title: s.overlayMetadata?.primaryText?.content || '',
          views: viewsText,
          viewsNum: parseKoViews(viewsText),
          thumb: s.thumbnail?.sources?.[0]?.url || '',
          url: `https://www.youtube.com/shorts/${id}`,
        });
      }
    }
    if (Array.isArray(node)) node.forEach(walk);
    else for (const k of Object.keys(node)) walk(node[k]);
  })(data);
  return { videos, shorts };
}

async function fetchYouTubeByKeywords(keywords, shortsMode) {
  // 영상: '이번 주 조회수순' 필터 검색 / 쇼츠: 일반 검색의 쇼츠 선반에서 수집
  const results = await Promise.allSettled(
    keywords.map((k) => {
      const q = k.replace(/^#/, '');
      return ytSearch(q, shortsMode ? undefined : YT_SORT_VIEWS_WEEK);
    }),
  );
  const seen = new Set();
  const items = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const pool = shortsMode ? r.value.shorts : r.value.videos;
    for (const v of pool.slice(0, shortsMode ? 10 : 5)) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      items.push({ ...v, keyword: keywords[i] });
    }
  });
  if (!items.length) throw new Error('no results');
  items.sort((a, b) => b.viewsNum - a.viewsNum);
  return items.slice(0, 20);
}

// trends24.in — X(트위터) 한국 실시간 트렌드 (가장 최신 카드 1개)
async function fetchXTrends() {
  const html = await fetchText('https://trends24.in/korea/');
  const list = html.match(/<ol class=trend-card__list>([\s\S]*?)<\/ol>/);
  if (!list) throw new Error('trend list not found');
  const items = [];
  const re = /<a href="([^"]+)"[^>]*class=trend-link[^>]*>([^<]*)<\/a><span class=tweet-count data-count="?([^">]*)"?/g;
  let m;
  while ((m = re.exec(list[1])) && items.length < 20) {
    const count = parseInt(m[3], 10);
    items.push({
      title: decodeEntities(m[2]),
      url: m[1].replace('twitter.com', 'x.com'),
      tweets: Number.isFinite(count) && count > 0 ? count : null,
    });
  }
  return items;
}

// tikwm 공개 피드 — 틱톡 인기 영상 (키 불필요)
async function fetchTikTok() {
  const res = await fetch('https://www.tikwm.com/api/feed/list?region=KR&count=20', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (json.code !== 0 || !Array.isArray(json.data)) throw new Error(json.msg || 'bad response');
  return json.data.map((v) => ({
    id: v.video_id,
    title: (v.title || '').trim() || '(제목 없음)',
    plays: v.play_count ?? null,
    likes: v.digg_count ?? null,
    author: v.author?.nickname || v.author?.unique_id || '',
    thumb: v.cover || '',
    url: v.author?.unique_id
      ? `https://www.tiktok.com/@${v.author.unique_id}/video/${v.video_id}`
      : `https://www.tiktok.com/video/${v.video_id}`,
  })).slice(0, 20);
}

// Threads: 무키 공개 트렌드 소스가 없음 → 구글 핫키워드 기반 검색 링크 생성
function buildThreadsLinks(googleItems, xItems) {
  const seen = new Set();
  const keywords = [];
  for (const it of [...(googleItems || []), ...(xItems || [])]) {
    const k = it.title.replace(/^#/, '');
    if (!seen.has(k)) { seen.add(k); keywords.push(it.title); }
    if (keywords.length >= 15) break;
  }
  return keywords.map((k) => ({
    title: k,
    url: `https://www.threads.net/search?q=${encodeURIComponent(k.replace(/^#/, ''))}&serp_type=default`,
  }));
}

// ------------------------------------------------------------- refresh -----

async function refreshAll(reason) {
  if (state.refreshing) return;
  state.refreshing = true;
  console.log(`[refresh] start (${reason})`);

  const set = (key, result, map = (v) => v) => {
    if (result.status === 'fulfilled') {
      state.trends[key] = { items: map(result.value), error: null };
    } else {
      state.trends[key].error = String(result.reason?.message || result.reason);
      console.warn(`[refresh] ${key} failed:`, state.trends[key].error);
    }
  };

  // 1차: 핫토픽 소스 (유튜브 검색의 시드 키워드로도 사용)
  const [google, x, tiktok] = await Promise.allSettled([
    fetchGoogleTrends(),
    fetchXTrends(),
    fetchTikTok(),
  ]);
  set('google', google);
  set('x', x);
  set('tiktok', tiktok);

  // 2차: 핫키워드 기반 유튜브 인기 영상/쇼츠
  const keywords = [
    ...state.trends.google.items.map((i) => i.title),
    ...state.trends.x.items.map((i) => i.title),
  ].slice(0, 6);
  if (!keywords.length) keywords.push('오늘 인기', '이슈');

  const [ytVideos, ytShorts] = await Promise.allSettled([
    fetchYouTubeByKeywords(keywords, false),
    fetchYouTubeByKeywords(keywords, true),
  ]);
  set('youtube', ytVideos);
  set('shorts', ytShorts);
  state.trends.threads = {
    items: buildThreadsLinks(state.trends.google.items, state.trends.x.items),
    error: null,
  };

  state.updatedAt = new Date().toISOString();
  state.refreshing = false;
  console.log(`[refresh] done — google:${state.trends.google.items.length} yt:${state.trends.youtube.items.length} shorts:${state.trends.shorts.items.length} x:${state.trends.x.items.length} tiktok:${state.trends.tiktok.items.length}`);
  broadcast('trends', { trends: state.trends, updatedAt: state.updatedAt });
}

// --------------------------------------------------------------- server ----

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > limit) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

const VALID_PLATFORMS = ['youtube', 'shorts', 'tiktok', 'threads', 'x', 'etc'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // --- API ---
  if (url.pathname === '/api/trends') {
    return json(res, 200, { trends: state.trends, updatedAt: state.updatedAt });
  }

  if (url.pathname === '/api/posts' && req.method === 'GET') {
    return json(res, 200, { posts });
  }

  if (url.pathname === '/api/posts' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const nick = String(body.nick || '익명').trim().slice(0, 20) || '익명';
      const platform = VALID_PLATFORMS.includes(body.platform) ? body.platform : 'etc';
      const title = String(body.title || '').trim().slice(0, 120);
      let link = String(body.url || '').trim().slice(0, 500);
      if (!title) return json(res, 400, { error: '제목/키워드를 입력해 주세요.' });
      if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
      const post = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        nick, platform, title, url: link,
        time: new Date().toISOString(),
      };
      posts.unshift(post);
      if (posts.length > 200) posts.length = 200;
      savePosts();
      broadcast('post', post);
      return json(res, 200, { ok: true, post });
    } catch (e) {
      return json(res, 400, { error: '잘못된 요청입니다.' });
    }
  }

  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    const now = Date.now();
    if (now - lastManualRefresh < MANUAL_REFRESH_COOLDOWN) {
      return json(res, 429, { error: '새로고침은 1분에 한 번만 가능해요.' });
    }
    lastManualRefresh = now;
    refreshAll('manual');
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: {"clients":${sseClients.size + 1}}\n\n`);
    sseClients.add(res);
    broadcast('clients', { count: sseClients.size });
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
      broadcast('clients', { count: sseClients.size });
    });
    return;
  }

  // --- static ---
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`TrendHub running → http://localhost:${PORT}`);
  refreshAll('startup');
  setInterval(() => refreshAll('interval'), REFRESH_MS);
});
