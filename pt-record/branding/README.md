# 병원 로고 적용

1. 로고 이미지를 이 폴더에 `logo.png` 로 넣습니다 (256px 이상, 투명 배경 권장).
2. `pip install pillow` 후 `python3 branding/apply-logo.py` 실행
   → `Index.html` 의 화면 로고·탭 아이콘·홈 화면 아이콘, `branding/icon.ico` 생성
3. `server/build-exe.sh` 로 exe 를 다시 빌드하면 exe 아이콘도 바뀝니다.
