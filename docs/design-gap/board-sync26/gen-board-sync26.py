#!/usr/bin/env python3
"""보드 반영 묶음 26 — 휴대폰(390) 보드 4단계 (UI_STATUS 「휴대폰(390) 보드 제안」 순서 4, MASTER (4) 승인 2026-10-06 · MASTER (5) 재가동 지시 2026-10-16).
PF-002 기능 · PF-004 자주 묻는 질문 · AU-003 아이디/비밀번호 찾기 · AU-011 아이디 찾기 · AU-012 직원 계정 연결 — 각 PC 정본 안에
「휴대폰 390」 상태 변형 블록을 PF-007-1~5와 같은 방식(상태 변형 격자 한 줄 전체 · 390 프레임)으로 추가한다. 새 파일 · canvas.json 변경 없음.
내용(문구 · 링크 · 상태 · 버튼)은 PC 정본 그대로 가져오고 배치만 1열로 바꾼다. 새 정보 · 새 CTA 없음.
- 공개(PF): 머리 streamshop-compact(PF-007-1 390 블록과 동일) · 본문 여백 16 · 제목 한 단계 축소(t-d2→t-t1, t-t2→t-t3, t-t1→t-t2) · 기능 행은 글 → 견본 순 1열 · 견본 카드 폭 100% · 바닥글 compact 1열.
- 인증(AU): c24 인증 카드를 390 프레임 안에서 폭 100%(안쪽 여백 16)로. 카드 내용은 PC와 같다(v342 현대화 수치 lop.css 공통 적용).
- PF-003은 TSX 정본(1440 고정)이라 이 묶음에서 제외(별도 판단). PF-007-1~5는 이미 「휴대폰 390」 블록이 있어 제외.
사용: gen-board-sync26.py <design/project 디렉터리>  (제자리 수정 · 다시 돌리면 표식 <!-- m390 --> 사이 블록을 지우고 새로 만든다)"""
import re, sys, pathlib
src = pathlib.Path(sys.argv[1])

def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text(encoding='utf-8')
def wr(f, s): (src / f).write_text(s, encoding='utf-8'); print('wrote', f, len(s))

HEADER_M = ('<header class="row between streamshop-header streamshop-compact" style="box-shadow: inset 0 -1px 0 var(--wds-line-normal-alternative)">'
            '<a class="logo streamshop-brand" href="PF-001.dc.html" style="font-size: 17px"><img src="/design-assets/public/branding/streamshop-symbol.png" alt="스트림샵" width="28" height="31" style="object-fit: contain"><span style="font-weight: 850; letter-spacing: -.04em">streamshop</span></a>'
            '<div class="row streamshop-actions"><a class="streamshop-login" href="AU-002.dc.html">로그인</a><button class="icon-btn" type="button" aria-label="메뉴"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg></button></div></header>')
FOOTER_M = ('<footer class="streamshop-footer" style="display: flex; flex-direction: column; gap: 14px">'
            '<div class="col" style="gap: 8px"><span class="logo streamshop-brand" style="font-size: 17px"><img src="/design-assets/public/branding/streamshop-symbol.png" alt="스트림샵" width="28" height="31" style="object-fit: contain"><span style="font-weight: 850; letter-spacing: -.04em">streamshop</span></span><span class="t-c1 c-alt">파트너스별 쇼핑몰과 라이브 방송 주문대기를 하나로</span></div>'
            '<div class="row" style="gap: 14px; flex-wrap: wrap"><a class="t-l2" href="PF-008.dc.html">이용약관</a><a class="t-l2 fw7" href="PF-009.dc.html">개인정보처리방침</a><a class="t-l2" href="PF-005.dc.html">공지</a><a class="t-l2" href="PF-004.dc.html">자주 묻는 질문</a></div>'
            '<span class="t-c1 c-alt" style="line-height: 1.6">상호 [플랫폼 상호] · 대표 [플랫폼 대표자] · 사업자등록번호 [플랫폼 사업자등록번호] · 통신판매업 신고 [플랫폼 통신판매업 신고번호] · 주소 [플랫폼 주소지] · 고객센터 [플랫폼 고객센터] · © 2026 [플랫폼 상호]</span></footer>')
def frame_pf(body):
    return ('<div class="st" style="grid-column: 1 / -1"><span class="st-tag">휴대폰 390</span>'
            '<div class="app streamshop-public" data-theme="light" style="width: 390px; display: flex; flex-direction: column; background: var(--surface); box-shadow: 0 0 0 1px var(--wds-line-normal-alternative); text-align: left; margin: 0 auto">'
            + HEADER_M + body + FOOTER_M + '</div></div>')
STATES_OPEN = '<div class="states" style="padding: 24px 0 0; background: transparent; box-shadow: none; grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: 1312px; margin: 0 auto"><span class="states-h">상태 변형</span>'

MARK_A, MARK_B = '<!-- m390 -->', '<!-- /m390 -->'
def strip_prev(t):
    """이전 실행이 남긴 「휴대폰 390」 블록(표식 사이)을 지워 다시 돌려도 결과가 같게 한다."""
    while MARK_A in t:
        a = t.index(MARK_A); b = t.index(MARK_B, a) + len(MARK_B); t = t[:a] + t[b:]
    return t
def set_height(t, h):
    import re as _re
    return _re.sub(r'"height":\d+', f'"height":{h}', t, count=1)
def put_pf(t, body_m, h):
    """공개 보드: 상태 변형 격자가 없으면 만들고(표식 포함) 390 블록을 넣는다."""
    t = strip_prev(t)
    block = MARK_A + STATES_OPEN + frame_pf(body_m) + '</div>' + MARK_B
    t = rep(t, '</footer>\n</div>\n</x-dc>', '</footer>\n' + block + '</div>\n</x-dc>')
    return set_height(t, h)
def put_au(t, card_inner, h):
    """인증 보드: 기존 상태 변형 격자 끝에 390 블록을 넣는다(표식 포함)."""
    t = strip_prev(t)
    t = rep(t, '\n</div>\n</div>\n</x-dc>', '\n' + MARK_A + frame_au(card_inner) + MARK_B + '</div>\n</div>\n</x-dc>')
    return set_height(t, h)

# 공개 보드 공통: 제목 위계 한 단계 축소
def shrink(s):
    return s.replace('class="t-d2"', 'class="t-t1"').replace('<h3 class="t-t2">', '<h3 class="t-t3">').replace('<h2 class="t-t1">', '<h2 class="t-t2">').replace('class="t-b1 c-neu"', 'class="t-b2 c-neu"')

def split_top(seg):
    """최상위 자식 div 들을 (시작, 끝) 로 나눈다 — 기능 행(글 col · 견본 card) 2개."""
    out, depth, start, i = [], 0, None, 0
    for m in re.finditer(r'<div\b[^>]*>|</div>', seg):
        if m.group(0).startswith('</'):
            depth -= 1
            if depth == 0: out.append(seg[start:m.end()]); start = None
        else:
            if depth == 0: start = m.start()
            depth += 1
    return out

# ---------- PF-002 기능 ----------
t = strip_prev(rd('PF-002.dc.html'))
a = t.index('</header>') + 9; b = t.index('<footer')
body = t[a:b]
key = '<div class="row" style="gap: 48px; align-items: center; padding: 56px 0; box-shadow: inset 0 -1px 0 var(--wds-line-normal-alternative)">'
sec_end = body.index('</section>')
head_sec = body[:body.index(key)]
rows_html = body[body.index(key):sec_end]
tail = body[sec_end:]
starts = [m.start() for m in re.finditer(re.escape(key), rows_html)] + [len(rows_html)]
rows_m = []
for i in range(len(starts) - 1):
    row = rows_html[starts[i]:starts[i + 1]]
    inner = row[len(key):]
    assert inner.endswith('</div>'), 'row end'
    kids = split_top(inner[:-6])
    assert len(kids) == 2, (i, len(kids))
    text = [k for k in kids if k.startswith('<div class="col"')][0]
    mock = [k for k in kids if k.startswith('<div class="card"')][0]
    mock = rep(mock, 'style="flex: 1; min-height: 320px; padding: 20px;', 'style="min-height: 0; padding: 16px;')
    mock = mock.replace('<div class="card col" style="width: 420px;', '<div class="card col" style="width: 100%;')
    rows_m.append('<div class="col" style="gap: 20px; padding: 32px 0; box-shadow: inset 0 -1px 0 var(--wds-line-normal-alternative)">' + text + mock + '</div>')
head_m = rep(head_sec, '<section style="padding: 80px 64px; background: var(--surface)">', '<section style="padding: 32px 16px 8px; background: var(--surface)">')
cta_m = rep(tail, '<section style="padding: 80px 64px; background: var(--page)">', '<section style="padding: 40px 16px; background: var(--page)">')
cta_m = rep(cta_m, '<div class="row" style="gap: 8px"><a class="btn btn-lg" href="PF-007-1.dc.html">파트너스 가입 신청</a><a class="btn btn-lg btn-out" href="PF-003.dc.html">요금 보기</a></div>',
            '<div class="col" style="gap: 8px; width: 100%"><a class="btn btn-lg btn-block" href="PF-007-1.dc.html">파트너스 가입 신청</a><a class="btn btn-lg btn-out btn-block" href="PF-003.dc.html">요금 보기</a></div>')
body_m = shrink(head_m + ''.join(rows_m) + cta_m)
t = put_pf(t, body_m, 9200)
wr('PF-002.dc.html', t)

# ---------- PF-004 자주 묻는 질문 ----------
t = strip_prev(rd('PF-004.dc.html'))
a = t.index('</header>') + 9; b = t.index('<footer')
body = t[a:b]
body_m = rep(body, '<section style="padding: 72px 64px 80px; background: var(--surface)">', '<section style="padding: 24px 16px 40px; background: var(--surface)">')
body_m = rep(body_m, '<div class="search" style="max-width: 520px">', '<div class="search" style="width: 100%">')
body_m = rep(body_m, '<div class="col" style="max-width: 900px">', '<div class="col">')
body_m = rep(body_m, '<div class="card row between" style="padding: 20px 24px; margin-top: 32px; max-width: 900px">', '<div class="card col" style="padding: 20px 16px; margin-top: 24px; gap: 12px">')
body_m = rep(body_m, '<a class="btn" href="SA-114.dc.html">문의하기</a>', '<a class="btn btn-block" href="SA-114.dc.html">문의하기</a>')
body_m = shrink(body_m)
t = put_pf(t, body_m, 3200)
wr('PF-004.dc.html', t)

# ---------- AU-003 · AU-011 · AU-012 ----------
def frame_au(card_inner):
    return ('<div class="st" style="grid-column: 1 / -1"><span class="st-tag">휴대폰 390</span>'
            '<div class="app c24" data-theme="light" style="width: 390px; margin: 0 auto; box-shadow: 0 0 0 1px var(--c24-line); text-align: left">'
            '<div class="authwrap" style="min-height: 0; padding: 24px 16px"><div class="auth" style="width: 100%; padding: 32px 16px">' + card_inner + '</div></div></div></div>')
for f in ('AU-003', 'AU-011', 'AU-012'):
    t = strip_prev(rd(f + '.dc.html'))
    a = t.index('<div class="auth" style="width: 420px">') + len('<div class="auth" style="width: 420px">')
    b = t.index('</div></div>\n<div class="states">')
    card_inner = t[a:b]
    card_inner = rep(card_inner, '<label class="ck"><input type="checkbox" name="r">', '<label class="ck" style="white-space: normal; flex-wrap: wrap; margin-right: 0"><input style="flex-shrink: 0" type="checkbox" name="r">')
    card_inner = rep(card_inner, '<a href="#">보기</a>', '<a href="#" style="white-space: nowrap; flex-shrink: 0">보기</a>')
    assert card_inner.count('<div class="auth"') == 0
    t = put_au(t, card_inner, 3200 if f == 'AU-012' else 4000)
    wr(f + '.dc.html', t)
print('done')

