#!/usr/bin/env bash
# 윈도우용 실행 파일(물리치료기록.exe) 빌드 — Node.js Single Executable Application
# 필요: 빌드 PC의 node 버전 = 내려받는 윈도우 node.exe 버전 (blob 형식이 버전별로 다름)
set -euo pipefail
cd "$(dirname "$0")"
VER="$(node -v)"
OUT=dist
NAME="물리치료기록"
mkdir -p "$OUT"

# 1) 윈도우용 node.exe 내려받고 공식 체크섬 확인
if [ ! -f "$OUT/node-$VER.exe" ]; then
  curl -fsSL -o "$OUT/node-$VER.exe" "https://nodejs.org/dist/$VER/win-x64/node.exe"
  curl -fsSL -o "$OUT/SHASUMS256.txt" "https://nodejs.org/dist/$VER/SHASUMS256.txt"
  want="$(grep ' win-x64/node.exe$' "$OUT/SHASUMS256.txt" | cut -d' ' -f1)"
  got="$(sha256sum "$OUT/node-$VER.exe" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || { echo "체크섬 불일치: node.exe"; rm -f "$OUT/node-$VER.exe"; exit 1; }
fi

# 2) server.js + Index.html 을 blob 으로 (코드캐시·스냅샷은 플랫폼 종속이라 끔)
cat > "$OUT/sea-config.json" <<EOF
{ "main": "../server.js", "output": "sea-prep.blob", "disableExperimentalSEAWarning": true,
  "useCodeCache": false, "useSnapshot": false, "assets": { "Index.html": "../../Index.html" } }
EOF
(cd "$OUT" && node --experimental-sea-config sea-config.json)

# 3) node.exe 에 주입
cp "$OUT/node-$VER.exe" "$OUT/$NAME.exe"
npx --yes postject@1.0.0-alpha.6 "$OUT/$NAME.exe" NODE_SEA_BLOB "$OUT/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# 4) 배포용 zip
PKG="$OUT/$NAME"
rm -rf "$PKG" "$OUT/$NAME.zip"; mkdir -p "$PKG"
cp "$OUT/$NAME.exe" "$PKG/"
{ printf '\xef\xbb\xbf'; sed 's/$/\r/' 사용방법.txt; } > "$PKG/사용방법.txt"   # 메모장용 BOM·CRLF
# 한글 파일명이 윈도우 탐색기에서 깨지지 않도록 UTF-8 플래그가 붙는 파이썬 zipfile 사용
(cd "$OUT" && python3 - "$NAME" <<'PY'
import sys, os, zipfile
name = sys.argv[1]
with zipfile.ZipFile(name + '.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(name):
        for f in files:
            z.write(os.path.join(root, f))
PY
)
echo "완료: $OUT/$NAME.zip"
