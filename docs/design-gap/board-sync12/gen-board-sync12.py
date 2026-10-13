#!/usr/bin/env python3
"""보드 반영 묶음 12 — 대표님 지시 2026-10-06 「로그아웃 누르면 반드시 컨펌창 띄운다」(MASTER (4) 전달).
마스터 · 파트너스 관리자 · 구매자 쇼핑몰의 모든 로그아웃(GNB 상단 유틸 · 휴대폰 ☰ 서랍 · 마이페이지)이 공통 확인 창을 거친다.
문구: 관리자 합니다체 「로그아웃하시겠습니까?」 · 구매자 해요체 「로그아웃할까요?」 · 버튼 [취소][로그아웃]. 기존 DS-CONFIRM 규격 그대로(재설계 없음).
① DS-CONFIRM: 규칙 ⑦ + 관리자 상태 ⑦ 로그아웃 + 구매자 PC 다이얼로그 · 휴대폰 바텀시트 로그아웃
② SA-LNB: 규칙 ⑤ 상단 유틸 로그아웃 → 확인 창
③ SA-FRAME-M: 서랍 「로그아웃」 캡션 + 상태 변형(휴대폰 관리자도 가운데 다이얼로그)
④ SH-020-IA(휴대폰 내 정보) · SH-020-PC-IA(PC 내 정보): 「로그아웃」 버튼 → 상태 변형(바텀시트 / PC 다이얼로그)
사용: gen-board-sync12.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>"""
import sys, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))

COL = '<div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start">'
ADMIN_CFM = ('<div class="cfm" style="max-width:420px"><div class="h">로그아웃하시겠습니까?<button class="x" type="button" aria-label="닫기">×</button></div>'
             '<div class="bd">이 기기에서 로그아웃됩니다 · 저장하지 않은 입력은 사라집니다.</div>'
             '<div class="f"><button class="b" type="button">취소</button><button class="b pri" type="button">로그아웃</button></div></div>')
BUYER_CFM = ('<div class="cfm" style="max-width:400px"><div class="h">로그아웃할까요?<button class="x" type="button" aria-label="닫기">×</button></div>'
             '<div class="bd">이 기기에서 로그아웃돼요.</div>'
             '<div class="f"><button class="btn" type="button">취소</button><button class="btn p" type="button">로그아웃</button></div></div>')
BUYER_SHEET = ('<div class="sh24 m" style="border:1px solid var(--c24-line,#d3d7de);width:390px;height:420px;min-height:420px;max-height:420px;position:relative;overflow:hidden;background:#f3f4f6;flex:none">'
               '<div class="sheet" style="justify-content:flex-end"><div class="pn"><div class="h">로그아웃할까요?<span class="x" aria-label="닫기">×</span></div>'
               '<div class="bd"><p style="margin:0;font-size:14px;line-height:20px;color:var(--sub)">이 기기에서 로그아웃돼요.</p>'
               '<div style="display:flex;gap:8px"><button class="btn l" type="button" style="flex:1">취소</button><button class="btn l p" type="button" style="flex:1">로그아웃</button></div></div></div></div></div>')
def st(tag, inner, hint):
    return f'<div class="st"><span class="st-tag">{tag}</span>{COL}{inner}<span class="hint">{hint}</span></div></div>'

# ① DS-CONFIRM
s = rd('DS-CONFIRM.dc.html')
s = rep(s, '차례로 맞춥니다.</span></div></div>',
        '차례로 맞춥니다.</span><span>⑦ 로그아웃(대표님 지시 2026-10-06): 마스터 · 파트너스 관리자 · 구매자 쇼핑몰의 모든 로그아웃(GNB 상단 유틸 · 휴대폰 ☰ 서랍 · 내 계정 · 마이페이지 버튼)은 반드시 이 창을 거칩니다. 관리자 「로그아웃하시겠습니까?」 · 구매자 「로그아웃할까요?」 · 버튼 [취소][로그아웃]. 실행 버튼은 기본(위험 색 아님) · 본문 한 줄 · 취소 · X · Esc · 바깥 클릭이면 그대로 머뭅니다 · 로그아웃 뒤 관리자는 로그인 화면, 구매자는 쇼핑몰 홈으로 갑니다.</span></div></div>')
s = rep(s, '오류 뒤에는 다시 열림</span></div></div>\n</div>',
        '오류 뒤에는 다시 열림</span></div></div>' + st('⑦ 로그아웃 (GNB 유틸 · 휴대폰 서랍 · 내 계정)', ADMIN_CFM,
            '마스터 · 파트너스 어디서 눌러도 이 창 · 실행 버튼은 기본 Primary(위험 색 아님) · 휴대폰 관리자도 가운데 다이얼로그 · 로그아웃 뒤 AU-001 · AU-002') + '\n</div>')
s = rep(s, '<button class="btn l p neg" type="button" style="flex:1">탈퇴하기</button></div></div></div></div></div></div></div>\n</div>',
        '<button class="btn l p neg" type="button" style="flex:1">탈퇴하기</button></div></div></div></div></div></div></div>'
        + st('구매자 · 로그아웃 · PC 다이얼로그', BUYER_CFM, 'PC 상단 유틸 「로그아웃」 · 내 정보 왼쪽 메뉴 「로그아웃」 모두 이 창 · 로그아웃 뒤 쇼핑몰 홈')
        + st('구매자 · 로그아웃 · 휴대폰 바텀시트', BUYER_SHEET, '휴대폰 내 정보 「로그아웃」 · ☰ 메뉴 「로그아웃」 모두 이 시트 · 버튼 48 두 개 반반') + '\n</div>')
s = rep(s, '관리자 6종 · 구매자 PC 2종 · 휴대폰 시트 2종', '관리자 7종 · 구매자 PC 3종 · 휴대폰 시트 3종', 0) if '관리자 6종' in s else s
assert s.count('로그아웃하시겠습니까?') == 2 and s.count('로그아웃할까요?') == 3
wr('DS-CONFIRM.dc.html', s)

# ② SA-LNB
s = rd('SA-LNB.dc.html')
s = rep(s, '그 아래 상세(SA-112~115)에는 ← 를 둔다.</span>',
        '그 아래 상세(SA-112~115)에는 ← 를 둔다. 로그아웃은 어디서 누르든(상단 유틸 · 휴대폰 서랍 · 내 계정) DS-CONFIRM ⑦ 「로그아웃하시겠습니까?」 확인 창을 거친다(대표님 지시 2026-10-06).</span>')
wr('SA-LNB.dc.html', s)

# ③ SA-FRAME-M
s = rd('SA-FRAME-M.dc.html')
s = rep(s, '<style>body{margin:0}</style>', '<style>body{margin:0}.c24 .st .cfm{position:relative}</style>')
s = rep(s, '② 메뉴 버튼 → 서랍 · 대분류 아코디언 → 하위 메뉴 · 유틸</p>', '② 메뉴 버튼 → 서랍 · 대분류 아코디언 → 하위 메뉴 · 유틸 · 「로그아웃」은 확인 창(DS-CONFIRM ⑦)</p>')
s = rep(s, '<a class="b " href="AU-002.dc.html">로그아웃</a>', '<button class="b " type="button">로그아웃</button>')
s = rep(s, '<button class="b pri" type="button">등록</button></div></div></div></div>\n</div>',
        '<button class="b pri" type="button">등록</button></div></div></div></div>'
        '<div class="states" style="padding:16px 24px"><span class="states-h">상태 변형</span>'
        + st('서랍 「로그아웃」 → 확인 창 (DS-CONFIRM ⑦)', ADMIN_CFM.replace('max-width:420px', 'max-width:358px'),
             '휴대폰 관리자도 서랍 위에 가운데 다이얼로그(모서리 16 · 폭 358 = 390 − 16×2) · 버튼 44 · 취소면 서랍이 그대로 열려 있음 · 로그아웃 뒤 AU-002')
        + '</div>\n</div>')
wr('SA-FRAME-M.dc.html', s)

# ④ SH-020-IA · SH-020-PC-IA
s = rd('SH-020-IA.dc.html')
s = rep(s, '<div class="msg cau">적립금 2,000원이 10/31에 사라져요</div></div></div></div>\n</div>',
        '<div class="msg cau">적립금 2,000원이 10/31에 사라져요</div></div></div></div>'
        + st('「로그아웃」 → 확인 시트 (DS-CONFIRM 구매자 휴대폰 · 대표님 지시 2026-10-06)', BUYER_SHEET, '내 정보 아래 「로그아웃」 · ☰ 메뉴 「로그아웃」 모두 이 시트 · [취소][로그아웃] 48 반반 · 로그아웃 뒤 쇼핑몰 홈') + '\n</div>')
wr('SH-020-IA.dc.html', s)

s = rd('SH-020-PC-IA.dc.html')
s = rep(s, '<style>body{margin:0}</style>', '<style>body{margin:0}.sh24 .cfm{position:relative}</style>')
s = rep(s, '<a href="SH-001-PC.dc.html">로그아웃</a>', '<a href="#">로그아웃</a>')
s = rep(s, '<a class="btn s p" href="SH-010-PC.dc.html">로그인</a></div></div></div>\n</div>',
        '<a class="btn s p" href="SH-010-PC.dc.html">로그인</a></div></div></div>'
        + st('「로그아웃」 → 확인 창 (DS-CONFIRM 구매자 PC · 대표님 지시 2026-10-06)', BUYER_CFM, '상단 유틸 「로그아웃」 · 왼쪽 메뉴 「로그아웃」 모두 이 창 · [취소][로그아웃] · 로그아웃 뒤 쇼핑몰 홈') + '\n</div>')
wr('SH-020-PC-IA.dc.html', s)
