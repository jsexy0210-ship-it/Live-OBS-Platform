#!/usr/bin/env python3
"""보드 반영 묶음 10 — MASTER (4) 배정 2026-10-06.
① MA-012-2 파트너스 상세 › 쇼핑몰 탭 「정책 점검」: 「금지 품목 · 미성년자 판매 제한 문구」 → 「미성년자 구매 안내 글 (법정 고지 · 약관)」 · 서버(#916 lib/server/admin/sellerShop.ts: minorRestriction = shopLegalNotice.minorNotice 입력 여부 → 기재됨/미기재, 법정 표시 기준 아님 · 입력 여부만) 기준으로 정리
사용: gen-board-sync10.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리> [높이 json]"""
import sys, re, pathlib, json, math
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))

s = rd('MA-012-2.dc.html')
s = rep(s, '<div class="sec-t">정책 점검</div><table class="lt"><thead><tr><th>항목</th><th>상태</th></tr></thead>',
        '<div class="sec-t">정책 점검<span class="nt">입력 여부만 봅니다 (법정 표시 기준 아님) · 미기재 항목은 「보완 요청 보내기」</span></div><table class="lt"><thead><tr><th>항목</th><th>상태</th></tr></thead>')
s = rep(s, '<tr><td>금지 품목 · 미성년자 판매 제한 문구</td><td><span class="tag y">미기재</span></td></tr>',
        '<tr><td>미성년자 구매 안내 글 (법정 고지 · 약관의 「미성년자 구매 안내」)</td><td><span class="tag y">미기재</span></td></tr>')
assert '금지 품목' not in s
wr('MA-012-2.dc.html', s)

c = json.loads(rd('canvas.json'))
for k, h in (json.loads(pathlib.Path(sys.argv[3]).read_text()).items() if len(sys.argv) > 3 else []):
    want = math.ceil((h + 20) / 10) * 10
    if c['boards'][k]['h'] < want: print('height', k, c['boards'][k]['h'], '->', want); c['boards'][k]['h'] = want
wr('canvas.json', json.dumps(c, ensure_ascii=False, indent=2) + '\n')
print('done')
