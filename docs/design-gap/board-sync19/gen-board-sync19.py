#!/usr/bin/env python3
"""보드 반영 묶음 19 — 구매자 쇼핑몰 (2) 정본 판단 요청 2026-10-06.
① SH-011-2 본인확인: 「성별」 「내 · 외국인」 선택(반반 폭 세그먼트)을 생년월일 아래 줄에 추가.
   근거: 서버 본인확인 시작 API는 birth7(생년월일 6자리 + 성별 · 내외국인 자리 1)을 필수로 받음(lib/server/identity/provider.ts:14 · verification.ts:66) ·
   파트너스 가입 정본 PF-007-2에 같은 두 칸이 이미 있음 → 구매자 가입 보드에도 같은 구조(.seg).
사용: gen-board-sync19.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>"""
import sys, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
s = (src / 'SH-011-2.dc.html').read_text()
def seg(label, a, b):
    return (f'<div style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0"><label style="font-size: 12px; font-weight: 700">{label}<span style="color: var(--neg)">*</span></label>'
            f'<div class="seg" style="display: flex"><button class="on" type="button" style="flex: 1">{a}</button><button class="" type="button" style="flex: 1">{b}</button></div></div>')
row = '<div style="display: flex; gap: 8px">' + seg('성별', '남', '여') + seg('내 · 외국인', '내국인', '외국인') + '</div>'
s = rep(s, '<span class="hint" style="margin: 0">숫자 8자리</span></div>', '<span class="hint" style="margin: 0">숫자 8자리</span></div>' + row)
s = rep(s, '본인 명의 휴대폰으로 확인해요 · 이름 · 생년월일 · 번호가 가입 정보에 들어가고 바꿀 수 없어요',
        '본인 명의 휴대폰으로 확인해요 · 이름 · 생년월일 · 성별 · 번호가 가입 정보에 들어가고 바꿀 수 없어요')
(out / 'SH-011-2.dc.html').write_text(s); print('wrote SH-011-2', len(s))
