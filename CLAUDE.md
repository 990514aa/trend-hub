# TrendHub — 프로젝트 지침

## 목적

유튜브·쇼츠·틱톡·스레드·X의 핫토픽/최다조회 콘텐츠를 한 화면에 모아 보여주는 공개 웹사이트 겸 PWA.
**철칙: 플랫폼 로그인 없음, API 키 발급 없음** — 공개 데이터(RSS·공개 페이지·공개 엔드포인트)만 수집한다.

- 공개 URL: https://trend-hub-k43q.onrender.com (Render 무료 플랜)
- GitHub: https://github.com/990514aa/trend-hub (public, `main` 브랜치)
- 로컬 실행: `node server.js` → http://localhost:4173 (Node 18+, `npm install` 불필요)

## 배포 (가장 중요)

**push만으로는 공개 사이트에 반영되지 않는다** (GitHub 웹훅 미연동). 반드시:

```bash
./deploy.sh   # = git push + Render 배포 훅 호출. 반영까지 2~3분
```

- 배포 훅 URL은 `.render-deploy-hook`에 있음 (gitignore됨 — 커밋 금지)
- GitHub push 인증은 macOS 키체인에 저장돼 있어 재인증 불필요. 인증이 깨지면: GitHub device flow(client_id `178c6fc778ccc68e1d6a`)로 코드 발급 → 사용자가 github.com/login/device 에 직접 입력 (코드 입력은 반드시 사용자가 한다)

## 완료 판정 기준

배포 작업은 아래를 모두 확인한 뒤에만 "완료"라고 보고한다:

1. `https://trend-hub-k43q.onrender.com/api/trends?region=KR|US|JP` 가 6개 섹션(google/youtube/shorts/tiktok/x/threads) 모두 items를 반환
2. 변경한 기능이 공개 URL에서 실제로 동작 (curl 또는 브라우저로 확인)

## 구조

```
server.js          # 수집 + API + SSE + 정적 서빙 전부 (zero-dependency)
public/            # index.html, app.js, app.css, sw.js, manifest.webmanifest, icons/
deploy.sh          # push + Render 배포 트리거
data/posts.json    # 공유 게시판 (gitignore, 서버 재시작 시 초기화될 수 있음)
```

## 데이터 소스 (전부 무키·무로그인 — 변경 시 이 원칙 유지)

| 섹션 | 소스 | 비고 |
|---|---|---|
| 핫토픽 | `trends.google.com/trending/rss?geo=` | 구 RSS(`/trendingsearches/daily/rss`)는 폐기됨 |
| 유튜브/쇼츠 | `youtube.com/youtubei/v1/search` (내부 공개 API) | 유튜브 인기 페이지(FEtrending)는 2025년 폐지 — 핫키워드 × "이번주 조회수순" 검색으로 대체. 쇼츠는 일반 검색의 `shortsLockupViewModel` 선반에서 수집 |
| X | `trends24.in/{korea,united-states,japan}` 파싱 | |
| 틱톡 | `tikwm.com/api/feed/list?region=` | 서드파티 미러 |
| 스레드 | 없음 — 핫키워드 → 스레드 검색 링크 | 공개 트렌드 API가 존재하지 않음 |

## 하지 말 것

- 외부 npm 의존성 추가 금지 (zero-dependency 유지)
- API 키·로그인이 필요한 데이터 소스로 교체 금지
- `.render-deploy-hook`, 토큰 등 비밀 값 커밋 금지
- 비공식 소스 파싱이 깨졌을 때 다른 섹션까지 죽이는 구조 금지 — 섹션별 독립 실패(error 필드) 유지

## 알아둘 것

- 무료 플랜: 15분 유휴 시 잠자기 → 첫 요청이 30~60초 걸릴 수 있음 (검증 시 타임아웃 넉넉히)
- 트렌드는 10분 주기 자동 갱신, SSE(`/api/stream`)로 접속자 전원에게 푸시
- 지역: KR/US/JP (`/api/trends?region=`), UI 토글은 localStorage에 기억
