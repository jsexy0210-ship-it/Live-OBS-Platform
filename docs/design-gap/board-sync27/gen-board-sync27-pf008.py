#!/usr/bin/env python3
"""묶음 27 추가 — PF-008 이용약관 휴대폰(390) 변형 블록 (MASTER (5) 요청 2026-10-16: 화면 대조 PF·AU 사후 렌더 대조에서 1024·390 정본 변형 없음).
PC 정본 그대로 · 배치만 1열. 구현(styles/public.css @media max-width:900px: .pf-doc 세로 · .pf-toc 정적 · 가로 줄바꿈 목차 gap 8/16)을 읽고 그대로 반영한다.
머리는 PF-007-1~5 · 묶음 26과 같은 streamshop-compact. 새 요소 없음. 사용: gen-board-sync27-pf008.py <design/project>"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
src = pathlib.Path(sys.argv[1])
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n); return s.replace(old, new)
t = (src / 'PF-008.dc.html').read_text(encoding='utf-8')
assert '<div class="states"' not in t
a = t.index('</header>') + 9; b = t.index('<footer'); body = t[a:b]
m = rep(body, '<section style="padding: 56px 64px 80px; background: var(--surface)"><div class="row" style="gap: 48px; align-items: flex-start"><aside class="col" style="width: 240px; gap: 12px; position: sticky; top: 96px">',
        '<section style="padding: 24px 16px 40px; background: var(--surface)"><div class="col" style="gap: 16px; align-items: stretch"><nav class="row" aria-label="목차" style="flex-wrap: wrap; gap: 8px 16px">')
m = rep(m, '</aside><article class="col" style="flex: 1; max-width: 820px; gap: 28px">', '</nav><article class="col" style="gap: 24px">')
m = rep(m, '<div class="row" style="gap: 10px"><span class="t-l2 c-alt num">제4판', '<div class="row" style="gap: 10px; flex-wrap: wrap"><span class="t-l2 c-alt num">제4판')
# 묶음 26 공개 블록과 같은 머리 · 바닥글 · 상태 격자
g26_src = (pathlib.Path(__file__).parent.parent / 'board-sync26' / 'gen-board-sync26.py').read_text(encoding='utf-8')
ns = {'re': __import__('re'), 'sys': sys, 'pathlib': pathlib}
exec(g26_src.split('# 공개 보드 공통')[0].split('src = pathlib.Path(sys.argv[1])')[1], ns)  # HEADER_M · FOOTER_M · frame_pf · STATES_OPEN 만 가져온다
t = rep(t, '</footer>\n</div>\n</x-dc>', '</footer>\n' + ns['STATES_OPEN'] + ns['frame_pf'](m) + '</div>\n</div>\n</x-dc>')
t = rep(t, '"height":1700', '"height":5200')
(src / 'PF-008.dc.html').write_text(t, encoding='utf-8'); print('wrote PF-008.dc.html', len(t))
