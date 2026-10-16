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

# ③ MA-041 실시간 방송 — 「강제 종료」 (MASTER (4) 요청 · 서버 #944 POST /api/admin/ops/live-broadcasts/[id]/end, 운영 · 최고관리자만, 사유 필수, 이미 끝났으면 409)
s = rd('MA-041.dc.html')
s = rep(s, '<style>body{margin:0}</style>', '<style>body{margin:0}.c24 .st .cfm{position:relative}</style>')
s = rep(s, '<th style="width: 190px">관리</th>', '<th style="width: 270px">관리</th>')
s = rep(s, '<a class="b sm" href="MA-012-5.dc.html">상세</a></div></td></tr>', '<a class="b sm" href="MA-012-5.dc.html">상세</a><button class="b sm" type="button">강제 종료</button></div></td></tr>', 8)
COL = '<div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start">'
CFM = ('<div class="cfm" style="max-width:420px"><div class="h">「문라이트마켓 · 수요 문라이트 박스 오픈」 방송을 강제 종료하시겠습니까?<button class="x" type="button" aria-label="닫기">×</button></div>'
       '<div class="bd">LIVE 상태를 종료로 바꿉니다 · 개봉 중인 주문대기 항목은 그대로 둡니다 · 사유는 로그 추적에 남습니다<label class="lbl-w" style="display:block;margin-top:12px"><span class="nt">사유 (필수)</span><input class="i w-f" type="text" value="" placeholder="종료 사유"></label></div>'
       '<div class="f"><button class="b" type="button">취소</button><button class="b neg pri dis" type="button" disabled>강제 종료</button></div></div>')
ST41 = (f'<div class="st"><span class="st-tag">강제 종료 확인 (운영 · 최고관리자 · 사유 필수) · 이미 끝난 방송</span>{COL}{CFM}<span class="hint">DS-CONFIRM ④ 위험 규격 · 사유를 입력해야 실행 버튼이 켜집니다 · 종료 뒤 목록에서 빠지고 토스트 「방송을 종료했습니다」</span>'
        '<div class="note cau" style="width: 100%">이미 끝난 방송입니다 · 목록을 다시 불러옵니다</div><span class="hint">서버가 이미 끝났다고 답하면(409) 창을 닫고 목록만 새로 고칩니다</span></div></div>')
s = rep(s, '조회 전용 권한입니다 · 변경 버튼은 보이지 않습니다 · 필요한 권한: 운영 현황 조회</div></div></div>\n</div>',
        '조회 전용 권한입니다 · 「대신 보기」 「강제 종료」 버튼은 보이지 않습니다 · 필요한 권한: 운영 현황 조회 · 강제 종료는 운영 · 최고관리자만</div></div></div>' + ST41 + '\n</div>')
assert s.count('강제 종료') >= 12
wr('MA-041.dc.html', s)

# ④ MA-051 파트너스 문의 — 「만족도 (7일) 4.6」 별점 → 「도움됨 (7일)」 비율 (MASTER (4) 결정 ①: 문의 평가는 「도움이 됐습니까?」 예 · 아니요뿐, 서버 helpful7d.rate)
s = rd('MA-051.dc.html')
s = rep(s, '<div><div class="k">만족도 (7일)</div><div class="v">4.6</div></div>', '<div><div class="k">도움됨 (7일)</div><div class="v">92%<small>「도움이 됐습니까?」 예 비율</small></div></div>')
assert '만족도' not in s
wr('MA-051.dc.html', s)
