#!/usr/bin/env python3
"""DRAFT→FINAL 묶음 3 (공통 틀 밖: OV 오버레이 · EM 메일 · OG 공유 카드) 전용 기준 · 용어 정리.
사용: gen-final-batch3.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리> (입력은 캔버스 아티팩트 사본)"""
import sys, re, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def dates(s):
    s = re.sub(r'(?<![\d/.])2026-(\d\d)-(\d\d)', r'2026.\1.\2', s)
    return re.sub(r'(?<![\d/.])(\d{1,2})/(\d{1,2})(?![\d/.])', lambda m: '2026.%02d.%02d' % (int(m.group(1)), int(m.group(2))), s)
changed = []
# EM 메일 6장: 날짜 연월일 · EM-101 「오버레이 주소」→「방송 화면 주소」
for f in ('EM-001', 'EM-002', 'EM-003', 'EM-004', 'EM-101', 'EM-102'):
    s0 = (src / f'{f}.dc.html').read_text(); s = dates(s0)
    if f == 'EM-101':
        s = rep(s, '오버레이 주소', '방송 화면 주소', 2)
        s = rep(s, '2026.10.09 (금)까지', '2026.10.09까지')
    assert '오버레이' not in s
    (out / f'{f}.dc.html').write_text(s); changed.append((f, s != s0))
# OG 2장: 변경 없음
for f in ('OG-001', 'OG-002'):
    (out / f'{f}.dc.html').write_text((src / f'{f}.dc.html').read_text()); changed.append((f, False))
# OV: 화면 · 설명 문구의 「오버레이」→「방송 화면」(보드 제목 <title> · 「오버레이 전용」은 그대로) · 날짜 연월일
ov_fix = {
  'OV-000': [('<h1>오버레이 효과 명세 · ', '<h1>방송 화면 효과 명세 · '), ('이 캔버스의 오버레이 아트보드에서', '이 캔버스의 방송 화면 아트보드에서'), ('오버레이 설정에서 켠 경우만', '방송 화면 설정에서 켠 경우만')],
  'OV-001-G': [('오버레이 패널 영역', '방송 화면 패널 영역')],
  'OV-004': [('오버레이 편집기에서', '방송 화면 편집기에서')],
  'OV-008': [('<h1>오버레이 기본 템플릿 3종 수치표</h1>', '<h1>방송 화면 기본 템플릿 3종 수치표</h1>')],
}
for p in sorted(src.glob('OV-*.dc.html')):
    f = p.name[:-8]; s0 = p.read_text(); s = s0
    for a, b in ov_fix.get(f, []): s = rep(s, a, b)
    if f in ('OV-007', 'OV-008'): s = dates(s)
    body = re.sub(r'<title>[^<]*</title>', '', s)
    assert not re.search(r'오버레이(?! 전용)', body), (f, re.findall(r'.{20}오버레이(?! 전용).{20}', body)[:2])
    (out / p.name).write_text(s); changed.append((f, s != s0))
print('changed:', [f for f, c in changed if c])
