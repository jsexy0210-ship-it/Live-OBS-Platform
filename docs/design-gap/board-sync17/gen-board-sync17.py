#!/usr/bin/env python3
"""보드 반영 묶음 17 — 화면-마스터 B (2) 요청 2026-10-06 (MASTER (4) 승인 뒤 반영).
① MA-032 구독료 수납: 일별 표 「유예 전환」 열 삭제 · 「연체 발생」 → 「연체 발생 (유예 시작)」 (PRODUCT_SCOPE:32 유예는 결제 실패 그날 시작되는 7일 기간 · 서버 #951에 별도 값 없음)
   · 「연체 목록 · 유예 목록 · 잠금 목록」 링크를 MA-024(청구 · 결제 내역)가 아니라 MA-023 구독 현황(상태 필터 적용)으로.
② MA-023 구독 현황: 상태 체크에 「유예」 「잠금」 「해지 예정」 추가(IA:58 · PRODUCT_SCOPE:195 상태 · 요약 타일과 일치) · 상태 변형 「MA-032 링크로 진입 (필터 적용 · 주소 보존)」 추가.
사용: gen-board-sync17.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>"""
import sys, pathlib, re
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))

# ① MA-032
s = rd('MA-032.dc.html')
s = rep(s, '<th class="num" style="width: 100px">연체 발생</th><th class="num" style="width: 100px">유예 전환</th></tr>',
        '<th class="num" style="width: 140px">연체 발생 (유예 시작)</th></tr>')
# 일별 행: 마지막 두 숫자 칸(연체 발생 · 유예 전환) 중 뒤 칸 삭제
def fix_row(m):
    cells = re.findall(r'<td class="num">[^<]*(?:<span[^>]*>[^<]*</span>)?</td>', m.group(1))
    assert len(cells) == 8, len(cells)  # 청구 · 수납 · 실패 · 대기 · 수납 금액 · 재시도 · 연체 발생 · 유예 전환
    return '<tr><td>' + m.group(0)[8:m.group(0).index('</td>')] + '</td>' + ''.join(cells[:-1]) + '</tr>'
s, n = re.subn(r'<tr><td>2026\.\d\d\.\d\d</td>(.*?)</tr>', fix_row, s)
assert n == 4 and '유예 전환' not in s
s = rep(s, '<a class="b sm" href="MA-024.dc.html">연체 목록</a>', '<a class="b sm" href="MA-023.dc.html">연체 목록</a>')
s = rep(s, '<a class="b sm" href="MA-024.dc.html">유예 목록</a>', '<a class="b sm" href="MA-023.dc.html">유예 목록</a>')
s = rep(s, '<a class="b sm" href="MA-024.dc.html">잠금 목록</a>', '<a class="b sm" href="MA-023.dc.html">잠금 목록</a>')
wr('MA-032.dc.html', s)

# ② MA-023
s = rd('MA-023.dc.html')
s = rep(s, '<label class="ck"><input type="checkbox" name="r">연체 11</label><label class="ck"><input type="checkbox" name="r">해지 8</label></td>',
        '<label class="ck"><input type="checkbox" name="r">연체 11</label><label class="ck"><input type="checkbox" name="r">유예 3</label><label class="ck"><input type="checkbox" name="r">잠금 2</label><label class="ck"><input type="checkbox" name="r">해지 예정 4</label><label class="ck"><input type="checkbox" name="r">해지 8</label></td>')
ST = ('<div class="st"><span class="st-tag">MA-032 수납 현황 링크로 진입 (연체 · 유예 · 잠금 목록)</span><div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start">'
      '<div class="note inf" style="width: 100%">상태 「유예」만 켜진 채 열립니다 · 조건은 주소에 보존되어 새로고침 · 뒤로 가기에도 그대로입니다 · 「초기화」를 누르면 전체 목록</div>'
      '<span class="hint">연체 목록 → 상태 「연체」 · 유예 목록 → 「유예」 · 잠금 목록 → 「잠금」 · 제목 앞 ← 는 MA-032로 돌아갑니다</span></div></div>')
s = rep(s, '필요한 권한: 구독 조회</div></div></div>\n</div>', '필요한 권한: 구독 조회</div></div></div>' + ST + '\n</div>')
wr('MA-023.dc.html', s)
