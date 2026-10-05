#!/usr/bin/env python3
"""
병원 로고 적용 — branding/logo.png (전체 로고) 와 branding/mark.png (심볼, 선택) 로
  1) Index.html 의 화면 로고·브라우저 탭 아이콘·홈 화면 아이콘 (data URL 로 내장)
  2) branding/icon.ico  (윈도우 exe 아이콘, build-exe.sh 가 사용)
를 만든다.  필요: pip install pillow

사용:  python3 branding/apply-logo.py [로고 이미지 경로] [심볼 이미지 경로]
      심볼(mark.png)이 있으면 작은 아이콘(exe·탭·홈 화면)에는 심볼만 쓰고, 화면 위쪽에는 전체 로고를 쓴다.
"""
import base64, io, os, re, sys
from PIL import Image, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'logo.png')
MARK = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'mark.png')
INDEX = os.path.join(ROOT, 'Index.html')

def load_trimmed(path):
    img = Image.open(path).convert('RGBA')
    return trim(img)


def trim(img):
  # 여백 잘라내기: 투명 배경이면 알파 기준, 아니면 모서리 색(흰 배경 등) 기준
  alpha_box = img.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
  if alpha_box and alpha_box != (0, 0, img.width, img.height):
      return img.crop(alpha_box)
  bg = Image.new('RGBA', img.size, img.getpixel((0, 0)))
  diff = ImageChops.difference(img, bg).convert('L').point(lambda v: 255 if v > 24 else 0)
  box = diff.getbbox()
  return img.crop(box) if box else img

img = load_trimmed(SRC)
mark = load_trimmed(MARK) if os.path.exists(MARK) else img

def square(im, pad_ratio=0.06, bg=(0, 0, 0, 0)):
    side = int(max(im.size) * (1 + pad_ratio * 2))
    canvas = Image.new('RGBA', (side, side), bg)
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)
    return canvas

sq = square(mark)
def png_data_url(im, size, bg=None):
    im = im.resize((size, size), Image.LANCZOS)
    if bg:
        base = Image.new('RGBA', im.size, bg); base.alpha_composite(im); im = base
    buf = io.BytesIO(); im.save(buf, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()

# 화면 위쪽 로고: 원래 비율 유지(가로로 긴 로고 그대로), 높이 최대 96px (원본보다 키우지 않음)
h = min(96, img.height); w = max(1, round(img.width * h / img.height))
header = img.resize((w, h), Image.LANCZOS)
buf = io.BytesIO(); header.save(buf, 'PNG', optimize=True)
header_url = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
icon_url = png_data_url(sq, 64)
touch_url = png_data_url(sq, 180, bg=(255, 255, 255, 255))   # iOS 는 투명을 검정으로 칠하므로 흰 배경

block = (
    '<!--BRAND-->\n'
    f'<link rel="icon" type="image/png" href="{icon_url}">\n'
    f'<link rel="apple-touch-icon" href="{touch_url}">\n'
    f'<script>window.BRAND_LOGO="{header_url}";</script>\n'
    '<!--/BRAND-->'
)
html = open(INDEX, encoding='utf-8').read()
html, n = re.subn(r'<!--BRAND-->.*?<!--/BRAND-->', lambda m: block, html, flags=re.S)
if n != 1:
    sys.exit('Index.html 에서 <!--BRAND--> 표시를 찾지 못했습니다.')
open(INDEX, 'w', encoding='utf-8').write(html)

ico = sq.resize((256, 256), Image.LANCZOS)
ico.save(os.path.join(HERE, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f'완료: 화면 로고 {w}x{h}, 아이콘 64/180px, icon.ico  (원본 {SRC})')
