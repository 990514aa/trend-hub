#!/bin/bash
# TrendHub 배포: 커밋된 변경을 GitHub에 올리고 Render 재배포를 트리거
set -e
cd "$(dirname "$0")"
git push origin main
curl -s -X POST "$(cat .render-deploy-hook)" && echo " ← Render 배포 시작됨 (2~3분 소요)"
