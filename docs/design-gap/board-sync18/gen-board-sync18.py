#!/usr/bin/env python3
"""보드 반영 묶음 18 — 휴대폰(390) 보드 1단계 (MASTER (4) 승인 순서 2026-10-06: 주문 · 환불 · 배송).
SA-021-M(전체 주문) · SA-022-M(주문 상세) · SA-023-M(취소 · 환불 요청) · SA-025-M(배송) 신설 — 틀은 SA-FRAME-M · 목록 카드는 SA-011-M(DS-TABLE-CARD) 규격 그대로,
내용(칩 · 검색 조건 · 열 · 상태 · 관리 버튼 · 문구)은 각 PC 정본(SA-021-OPS v287 · SA-022 v337 · SA-023 v316 · SA-025 v336)에서 가져온다. 새 정보 · 새 CTA 없음.
휴대폰 규칙: 상단 띠(메뉴 · 로고 · 알림) · 제목 줄 · 검색 조건은 접힘(fold) → 펼치면 1열 · 행 = 카드(제목 · 상태 · 「항목명 : 값」 · 관리 버튼) · 선택하면 아래 띠에 일괄 처리 · 상세 화면은 ← 버튼 + 1열 kv.
사용: gen-board-sync18.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>"""
import sys, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))

HEAD = ('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<title>{title}</title>\n<script src="./support.js"></script>\n'
        '<link rel="stylesheet" href="ds/wds/tokens.css">\n<link rel="stylesheet" href="lop.css">\n</head>\n<body>\n<x-dc>\n<helmet>\n<style>body{{margin:0}}.c24.mob .m-kv span .tag{{vertical-align:middle}}.c24.mob .m-kvs.one{{grid-template-columns:1fr}}.c24.mob .m-kvs.one .m-kv b{{width:72px}}.c24.mob .m-kvs.one .m-kv span{{white-space:normal;flex:1}}.c24.mob .m-kvs.one .m-kv span>.i{{width:100%;box-sizing:border-box}}.c24.mob .sum.g2{{grid-auto-flow:row;grid-template-columns:1fr 1fr}}.c24.mob .sum.g2>div:nth-child(-n+2){{border-bottom:1px solid var(--c24-line2)}}.c24.mob .sum.g2>div:nth-child(2n){{border-right:0}}.c24.mob .m-bar.wrap{{flex-wrap:wrap}}.c24.mob .m-bar .brow{{display:flex;gap:8px;width:100%}}.c24.mob .m-bar .brow .i{{height:48px;flex:1;min-width:0}}</style>\n</helmet>\n'
        '<div class="app c24 mob" data-theme="light" style="width: 884px">\n<div class="mobs">')
TAIL = ('</div>\n</div>\n</x-dc>\n<script type="text/x-dc" data-dc-script data-props=\'{{"$preview":{{"width":884,"height":{h}}}}}\'>\n'
        'class Component extends DCLogic {{ renderVals() {{ return {{}}; }} }}\n</script>\n</body>\n</html>\n')
TOP = ('<div class="top"><button class="mn" type="button" aria-label="메뉴"><i></i><i></i><i></i></button><a class="brand" href="SA-002-M.dc.html">'
       '<span class="logo-sym" style="--brand: #fff; --brand-ink: var(--c24-gnb)"></span>ONQ <small>파트너스 관리자</small></a>'
       '<a class="bell" href="SA-130.dc.html" aria-label="알림 센터">알림<em>3</em></a></div>')
def mph(h1, path, acts='', back=None):
    bk = f'<a class="b sm" href="{back}" aria-label="이전 화면" style="width: 44px; min-width: 44px; padding: 0; font-size: 18px">←</a>' if back else ''
    title = f'<div style="display: flex; align-items: center; gap: 8px">{bk}<h1 style="margin: 0">{h1}</h1></div>' if back else f'<h1>{h1}</h1>'
    return f'<div class="mph">{title}<span class="path">{path}</span>{("<div class=\"acts\">" + acts + "</div>") if acts else ""}</div>'
import json as _j
HJ = pathlib.Path(__file__).with_name('heights.json'); H = _j.loads(HJ.read_text()) if HJ.exists() else {}
_ph = []
def phone(cap, h, body, bar=''):
    _ph.append(h); h = H.get(f'{CUR}/{len(_ph)}', h)
    return f'<div class="phw"><p class="cap">{cap}</p><div class="m-ph" style="height: {h}px">{TOP}{body}{bar}</div></div>'
def card(title, small, tag, kvs, acts='', sel=False, href='#', check=True, one=False):
    kv = ''.join(f'<div class="m-kv"><b>{k}</b><span>{v}</span></div>' for k, v in kvs)
    ck = f'<input type="checkbox"{" checked" if sel else ""}>' if check else ''
    return (f'<div class="m-card{" sel" if sel else ""}"><div class="hd">{ck}<div class="nm"><a href="{href}">{title}</a><small>{small}</small></div>{tag}</div>'
            f'<div class="m-kvs{" one" if one else ""}">{kv}</div>{("<div class=\"ac\">" + acts + "</div>") if acts else ""}</div>')
def fold(label, summary): return f'<a class="fold" href="#">{label} <span>{summary}</span></a>'
def chips(items): return '<div class="chips" style="overflow-x: auto; white-space: nowrap; display: flex; gap: 6px; padding: 4px 0">' + ''.join(f'<button class="chip{c}" type="button">{t} <span class="n">{n}</span></button>' for t, n, c in items) + '</div>'
def f1(label, inner): return f'<div class="f1"><label>{label}</label>{inner}</div>'
def radios(name, opts, on=0): return '<div class="cks">' + ''.join(f'<label class="ck"><input type="radio" name="{name}"{" checked" if i == on else ""}>{o}</label>' for i, o in enumerate(opts)) + '</div>'
def sel(opts, cls='i '): return f'<select class="{cls}">' + ''.join(f'<option{" selected" if i == 0 else ""}>{o}</option>' for i, o in enumerate(opts)) + '</select>'
PRE = '<div class="pre"><button class="b sm" type="button">오늘</button><button class="b sm" type="button">7일</button><button class="b sm dark" type="button">1개월</button><button class="b sm" type="button">3개월</button><button class="b sm" type="button">전체</button></div><div class="row"><input class="i " type="text" value="2026-09-06" placeholder="날짜 선택"><span class="unit">~</span><input class="i " type="text" value="2026-10-06" placeholder="날짜 선택"></div>'
SBTN = '<div class="sbtn"><button class="b pri" type="button">검색</button><button class="b " type="button">초기화</button></div>'
PG = '<div class="pg2"><a href="#" class="b">‹ 이전</a><a href="#" class="b">다음 ›</a></div>'
def kvbox(title, rows, note=''):
    r = ''.join(f'<div class="m-kv"><b>{k}</b><span>{v}</span></div>' for k, v in rows)
    return f'<div class="m-card"><div class="hd"><div class="nm"><a href="#">{title}</a></div></div><div class="m-kvs one">{r}</div>{note}</div>'
def tag(t, c): return f'<span class="tag {c}">{t}</span>'

# ---------- SA-021-M 전체 주문 (SA-021-OPS v287) ----------
ACTS21 = '<a class="b " href="SA-024.dc.html">입금 확인</a><a class="b " href="SA-025-M.dc.html">배송</a>'
cards21 = (card('홀로그램 피닉스 풀아트 ×1', '20261002-0421 · 10.02 20:58 · 피닉스덕후 (골드)', tag('입금 전', 'y'), [('금액', '450,000원'), ('결제', '무통장 · 입금자명 박피닉'), ('경과', '1시간 4분'), ('방송', '스타라이트 브레이크')], '<button class="b sm pri" type="button">입금 확인</button><a class="b sm" href="SA-022-M.dc.html">상세</a><button class="b sm" type="button" aria-label="더보기">···</button>', href='SA-022-M.dc.html')
           + card('선라이트 스타터 덱 ×1', '20261002-0418 · 10.02 18:40 · 탈퇴 회원', tag('취소 요청', 'r'), [('금액', '24,000원'), ('결제', '카드'), ('사유', '단순 변심 · 미개봉'), ('경과', '3시간 22분')], '<a class="b sm pri" href="SA-023-M.dc.html">환불 처리</a><a class="b sm" href="SA-022-M.dc.html">상세</a><button class="b sm" type="button" aria-label="더보기">···</button>', href='SA-022-M.dc.html')
           + card('문라이트 컬렉션 박스 ×1 외 2', '20261002-0417 · 10.02 20:44 · 카드왕 (VIP)', tag('개봉 완료', 'g'), [('금액', '386,000원'), ('결제', '카드'), ('개봉', '20:52 완료 · HIT 1'), ('경과', '1시간 18분')], '<button class="b sm pri" type="button">배송 준비</button><a class="b sm" href="SA-022-M.dc.html">상세</a><button class="b sm" type="button" aria-label="더보기">···</button>', sel=True, href='SA-022-M.dc.html')
           + card('스타라이트 부스터 박스 ×2', '20261002-0416 · 10.02 20:41 · 별빛사냥꾼 (VIP)', tag('개봉 완료', 'g'), [('금액', '178,200원'), ('결제', '카드'), ('개봉', '20:49 완료'), ('경과', '1시간 21분')], '<button class="b sm pri" type="button">배송 준비</button><a class="b sm" href="SA-022-M.dc.html">상세</a><button class="b sm" type="button" aria-label="더보기">···</button>', sel=True, href='SA-022-M.dc.html')
           + card('드래곤 소울 부스터 ×3', '20261002-0412 · 10.02 19:58 · 민트컨디션 (실버)', tag('송장 미입력', 'y'), [('금액', '27,500원'), ('결제', '카드'), ('배송', '배송 준비 · 송장 없음'), ('경과', '2시간 4분')], '<button class="b sm pri" type="button">송장 입력</button><a class="b sm" href="SA-022-M.dc.html">상세</a><button class="b sm" type="button" aria-label="더보기">···</button>', href='SA-022-M.dc.html'))
body21a = (mph('전체 주문', '주문 › 전체 주문', ACTS21) + '<div class="body">'
           + chips([('오늘', 24, ' on'), ('입금 전', 4, ' hot'), ('배송 준비 전', 3, ' hot'), ('송장 미입력', 5, ' hot'), ('취소 · 환불 요청', 2, ' hot'), ('개봉 대기', 7, ''), ('전체', 126, '')])
           + fold('상세 검색', '오늘 · 주문 상태 전체') + '<div class="sort">' + sel(['최근 접수순', '오래된 접수순', '금액 높은순']) + sel(['20개씩', '50개씩']) + '</div>'
           + '<div class="m-cards">' + cards21 + '</div>' + PG + '</div>')
bar21 = '<div class="m-bar wrap"><span class="n">2개 선택</span><span class="nt">개봉 완료만</span><div class="brow"><button class="b pri" type="button">배송 준비로 변경</button><button class="b " type="button">송장 일괄 입력</button></div></div>'
body21b = (mph('전체 주문', '주문 › 전체 주문', ACTS21) + '<div class="body"><div class="box">'
           + f1('검색어', '<div class="row">' + sel(['주문번호', '구매자 닉네임', '상품명', '입금자명'], 'i w-s') + '<input class="i " type="text" value="" placeholder="검색어 입력"></div>')
           + f1('주문 상태', radios('s', ['전체', '입금 전', '개봉 대기', '개봉 완료', '배송 준비', '발송', '취소 · 환불 요청']))
           + f1('결제 수단', radios('p', ['전체', '카드', '무통장']))
           + f1('방송', sel(['전체 방송', '10.02 스타라이트 · 문라이트 브레이크', '10.01 151 케이스 오픈']))
           + f1('접수 기간', PRE) + SBTN + '</div></div>')
CUR = 'SA-021-M'; _ph.clear()
s = (HEAD.format(title='전체 주문 (휴대폰)') + phone('① 칩으로 거르기(홈 「오늘 처리할 일」과 같은 주소) · 상세 검색 접힘 · 행 = 카드(상품 · 주문번호 · 구매자 · 상태 · 금액 · 결제 · 경과) · 관리 버튼은 상태별(입금 확인 · 환불 처리 · 배송 준비 · 송장 입력) + 상세 + ··· · 선택하면 아래 띠에 일괄 처리', 2500, body21a, bar21)
     + phone('② 상세 검색 펼침 · 1열 · 「검색 · 초기화」는 폭 전체 · 조건은 주소에 보존(Back · 새로고침)', 2500, body21b) + TAIL.format(h=H.get(CUR + '/preview', 2550)))
wr('SA-021-M.dc.html', s)

# ---------- SA-022-M 주문 상세 (SA-022 v337) ----------
ACTS22 = '<a class="b " href="SA-023-M.dc.html">취소 · 환불</a><button class="b pri" type="button">송장 입력</button>'
body22a = (mph('주문 상세', '주문 › 전체 주문 › 주문 상세', '', back='SA-021-M.dc.html') + '<div class="body">'
           '<div class="box" style="padding: 12px 14px; display: flex; align-items: center; gap: 8px"><b>20261002-0409</b><button class="b sm" type="button">복사</button><span class="sp"></span>' + tag('개봉 중', 'y') + '</div>'
           '<div class="m-cards">'
           + card('스타라이트 부스터 박스 36팩', '1박스 × 1', tag('개봉 중', 'y'), [('판매가', '189,000원'), ('주문대기', tag('대상', 'bl'))], check=False, href='SA-012.dc.html', one=True)
           + kvbox('결제 요약', [('상품 금액', '189,000원'), ('적립금 사용', '−5,000원'), ('배송비', '0원 (50,000원 이상 무료)'), ('결제 금액', '<b>184,000원</b>'), ('적립 예정', '+5,670원 (카드 3%) · 배송 완료 후'), ('쿠폰', '사용 안 함')])
           + kvbox('결제 정보', [('결제 수단', '신용카드 (국민 ****-1234) · 일시불'), ('결제 시각', '2026.10.02 14:02:08'), ('승인번호', '30021877 · 정상 승인'), ('개봉 상품 고지', '동의함 · 결제 전 확인'), ('환불 가능 범위', '전액 · 부분 (카드 승인 취소)'), ('현금영수증', '신청 안 함 · 매출전표로 대신')])
           + kvbox('구매자 · 배송', [('방송 닉네임', '별빛사냥꾼'), ('회원', '별빛사냥꾼 (VIP) · 누적 주문 12건'), ('받는 분', '[이름] · [휴대폰 번호]'), ('배송지', '([우편번호]) [배송지 주소] [상세 주소]'), ('배송 메모', '부재 시 문 앞에 놓아 주십시오'), ('송장', '아직 보내지 않았습니다')], '<span class="hint" style="padding: 0 12px 10px; display: block">연락처 · 주소 열람은 로그 추적에 남습니다</span>')
           + kvbox('HIT 기록', [('HIT 카드', '홀로그램 피닉스 풀아트 · 14:03:40 · 방송 화면 6초 ' + tag('HIT', 'y'))])
           + '<div class="m-card"><div class="hd"><div class="nm"><a href="#">메모 <small>파트너스 · 직원만 봅니다</small></a></div></div><div style="padding: 0 12px 12px"><textarea class="i w-f" placeholder="주문 처리 메모 (파트너스 · 직원만 봅니다)">김직원 · 14:05 슬리브 2장 추가 요청. 완료 시 동봉.</textarea><div style="margin-top: 8px"><button class="b sm pri" type="button">저장</button></div></div></div>'
           + fold('상태 이력 · 알림 발송', '8건 · 알림 2건 발송') + '</div></div>')
bar22 = '<div class="m-bar save">' + ACTS22 + '</div>'
hist = [('14:05:12', '결제 취소 완료 5,000원', '자동 · 카드사 취소 승인 30021877-1'), ('14:05:10', '결제 취소 요청 5,000원', '자동 · 일부 환불에 따른 카드 부분 취소'), ('14:05:03', '일부 환불 5,000원 · 1개', '김직원 · 구매자 요청 · 포장 파손'), ('14:02:40', '개봉 중', '대표 · 타이머 60초'), ('14:02:10', '주문대기 등록 · 앞에 3건', '자동'), ('14:02:08', '결제 완료', '자동'), ('14:02:08', '결제 승인 184,000원', '자동 · 승인 30021877'), ('14:01:52', '주문 생성', '구매자 · 쇼핑몰 모바일')]
body22b = (mph('주문 상세', '주문 › 전체 주문 › 주문 상세', '', back='SA-021-M.dc.html') + '<div class="body">'
           + fold('상태 이력 · 알림 발송', '펼침') + '<div class="m-cards">'
           + kvbox('상태 이력 <small>시각 순</small>', [(t, f'{st}<br><small class="nt">{who}</small>') for t, st, who in hist])
           + kvbox('알림 발송', [('14:02', '주문 접수 알림 · 알림톡 · 발송 완료'), ('14:02', '개봉 시작 알림 · 알림톡 · 발송 완료'), ('—', '완료 알림 · 대기')])
           + '</div></div>')
CUR = 'SA-022-M'; _ph.clear()
s = (HEAD.format(title='주문 상세 (휴대폰)') + phone('① ← 전체 주문 · 주문번호 + 복사 · 상품 카드 · 결제 요약 · 결제 정보 · 구매자 · 배송 · HIT · 메모 (1열 「항목명 : 값」) · 아래 고정 띠에 「취소 · 환불」 「송장 입력」', 2700, body22a, bar22)
     + phone('② 「상태 이력 · 알림 발송」 펼침 · 시각 순 · 처리 주체는 작은 글자', 1900, body22b, bar22) + TAIL.format(h=H.get(CUR + '/preview', 2750)))
wr('SA-022-M.dc.html', s)

# ---------- SA-023-M 취소 · 환불 요청 (SA-023 v316) ----------
RT23 = '<div class="rtabs"><a class="on" href="SA-023-M.dc.html">취소 · 환불</a><a class="" href="SA-029.dc.html">교환 · 반품</a></div>'
cards23 = (card('선라이트 스타터 덱 ×1', '20261002-0418 · 10.02 18:40 · 1일째 기다리는 중', tag('처리 대기', 'y'), [('구매자', '탈퇴 회원'), ('금액', '24,000원'), ('사유', '단순 변심 · 미개봉'), ('결제', '카드')], '<button class="b sm pri" type="button">처리</button><a class="b sm" href="SA-022-M.dc.html">주문 상세</a>', check=False, href='SA-022-M.dc.html')
           + card('홀로그램 피닉스 풀아트 ×1', '20261002-0415 · 10.02 16:05', tag('처리 대기', 'y'), [('구매자', '밤하늘 (골드)'), ('금액', '45,000원'), ('사유', '잘못 주문 · 일부 상품'), ('결제', '카드')], '<button class="b sm pri" type="button">처리</button><a class="b sm" href="SA-022-M.dc.html">주문 상세</a>', check=False, href='SA-022-M.dc.html')
           + card('부스터 팩 151 ×3', '20261002-0411 · 10.02 14:22', tag('처리 대기', 'y'), [('구매자', '카드수집가 (실버)'), ('금액', '18,000원'), ('사유', '품절 안내 받음'), ('결제', '카드')], '<button class="b sm pri" type="button">처리</button><a class="b sm" href="SA-022-M.dc.html">주문 상세</a>', check=False, href='SA-022-M.dc.html'))
body23a = (mph('취소 · 환불 요청', '주문 › 취소 · 교환 · 반품', '<a class="b " href="SA-021-M.dc.html">전체 주문</a>') + '<div class="body">' + RT23
           + '<span class="nt" style="display: block; margin: 8px 0">발송 전 주문에서 구매자가 보낸 환불 요청입니다. 승인하면 요청한 상품으로 바로 환불되고, 거절하면 사유가 구매자에게 보입니다.</span>'
           + chips([('처리 대기', 3, ' on hot'), ('승인', 12, ''), ('거절', 2, ''), ('철회', 1, '')])
           + '<div class="ltop"><b>처리 대기 3건</b><span class="nt">요청 시각 오래된 순</span></div><div class="m-cards">' + cards23 + '</div></div>')
body23b = (mph('환불 처리', '주문 › 취소 · 교환 · 반품 › 환불 처리', '', back='SA-023-M.dc.html') + '<div class="body">'
           '<div class="sum g2"><div><div class="k">구매자</div><div class="v">밤하늘</div></div><div><div class="k">접수</div><div class="v">10.02 14:10</div></div><div><div class="k">결제</div><div class="v">15,000원<small>카드</small></div></div><div><div class="k">상태</div><div class="v">' + tag('환불 요청', 'r') + '</div></div></div>'
           '<div class="note inf">구매자 환불 요청 · 주문대기에서 자동 제외되었습니다. 범위와 사유를 정한 뒤 환불을 실행하거나 거절해 주십시오. 사유: 잘못 주문했어요</div>'
           '<div class="box">' + f1('환불 범위', radios('rg', ['주문 전체 환불 · 15,000원 · 카드 승인 취소', '일부 상품만'])) + '</div>'
           '<div class="m-cards">' + card('스타라이트 낱개 팩', '1개 · 6,000원', tag('개봉 전', 'n'), [('환불 대상', tag('가능', 'g'))], check=True, sel=True, one=True) + card('코스믹 낱개 팩', '1개 · 6,000원', tag('개봉 전', 'n'), [('환불 대상', tag('가능', 'g'))], check=True, sel=True, one=True) + kvbox('배송비', [('3,000원', '전액 환불 시 포함')]) + '</div>'
           '<div class="box">' + f1('사유 주체 <span class="rq">*</span>', radios('who', ['구매자 사정 (변심 · 잘못 주문)', '파트너스 사정 (품절 · 오류)']) + '<span class="hint">구매자 사정만 결제 후 취소 횟수에 들어갑니다 · 고르지 않으면 환불할 수 없습니다</span>')
           + f1('처리 사유 <span class="rq">*</span>', sel(['사유 선택', '품절 · 재고 없음', '결제 오류 · 중복 결제', '구매자 요청', '기타']))
           + f1('구매자에게 보낼 메시지', '<textarea class="i w-f" placeholder="선택 · 해요체로 자동 안내"></textarea>')
           + f1('알림', '<div class="cks"><label class="ck"><input type="checkbox" name="r" checked>환불 완료 알림 발송 (주문자 알림 설정 기준)</label></div>') + '</div>'
           + kvbox('환불 요약', [('결제 금액', '15,000원'), ('환불 금액', '<b>15,000원</b>'), ('환불 수단', '원결제 카드 승인 취소 · 3~5영업일'), ('적립금 회수', '−120원 (지급 대기분 취소)'), ('적립금 반환', '0원 (사용한 적립금 없음)'), ('쿠폰', '해당 없음')])
           + '<div class="note cau">환불 뒤에는 되돌릴 수 없습니다 · 실행 전 금액을 다시 확인해 주십시오</div></div>')
bar23 = '<div class="m-bar save"><button class="b " type="button">거절</button><button class="b neg pri" type="button">15,000원 환불</button></div>'
CUR = 'SA-023-M'; _ph.clear()
s = (HEAD.format(title='취소 · 환불 요청 (휴대폰)') + phone('① 탭(취소 · 환불 / 교환 · 반품) · 칩(처리 대기 · 승인 · 거절 · 철회, 주소 ?status=) · 행 = 카드(주문번호 · 상품 · 구매자 · 금액 · 사유) · 「처리」', 1900, body23a)
     + phone('② 「처리」 → 전체 화면(← 목록) · 요약 · 환불 범위 · 상품 체크 · 사유 주체 · 처리 사유 · 메시지 · 환불 요약 · 아래 고정 띠 [거절][N원 환불](DS-CONFIRM ⑤ 매우 위험: 실행 전 확인 창에서 금액 재입력)', 2900, body23b, bar23) + TAIL.format(h=H.get(CUR + '/preview', 2950)))
wr('SA-023-M.dc.html', s)

# ---------- SA-025-M 배송 (SA-025 v336) ----------
RT25 = '<div class="rtabs"><a class="on" href="SA-025-M.dc.html">배송 준비</a><a class="" href="SA-027.dc.html">송장 발급</a><a class="" href="SA-028.dc.html">출력 · 추적</a></div>'
ACTS25 = '<a class="b pri" href="SA-027.dc.html">송장 발급</a><a class="b " href="SA-028.dc.html">출력 · 추적</a>'
def ship(name, when, item, addr, sel_=False):
    return card(name, when, tag('배송 준비', 'bl'), [('상품', item), ('받는 분', '[이름] · [휴대폰 번호]'), ('주소', addr), ('택배사', sel(['택배사 선택', '[택배사]'], 'i w-f')), ('송장번호', '<input class="i w-f" type="text" value="" placeholder="송장번호 숫자 10~14자리">')], '<button class="b sm pri" type="button">발송 처리</button><a class="b sm" href="SA-022-M.dc.html">주문 상세</a>', sel=sel_, href='SA-022-M.dc.html', one=True)
cards25 = (ship('별빛사냥꾼', '14:12 주문 · 개봉 완료 14:03', '스타라이트 부스터 박스 ×1', '서울 강남구 [배송지 주소]', True) + ship('카드왕', '13:50 주문 · 개봉 완료 13:58', '드래곤 소울 부스터 ×3', '부산 해운대구 [배송지 주소]', True)
           + ship('민트컨디션', '13:31 주문 · 개봉 완료 13:40', '문라이트 컬렉션 박스 ×1', '제주 제주시 [배송지 주소] · 도서산간') + ship('피닉스덕후', '13:05 주문 · 개봉 완료 13:20', '홀로그램 피닉스 풀아트 ×1', '대구 수성구 [배송지 주소]'))
body25a = (mph('배송', '주문 › 배송 · 송장 › 배송', ACTS25) + '<div class="body">' + RT25
           + '<div class="sum g2"><div><div class="k">배송 준비</div><div class="v">12건</div></div><div><div class="k">오늘 발송</div><div class="v">23건</div></div><div><div class="k">배송 중</div><div class="v">8건</div></div><div><div class="k">도서산간</div><div class="v">2건<small>추가비 포함</small></div></div></div>'
           + fold('검색 조건', '최근 1개월 · 배송 준비') + '<div class="m-cards">' + cards25 + '</div>' + PG + '</div>')
bar25 = '<div class="m-bar wrap"><span class="n">2개 선택</span>' + sel(['택배사 일괄 지정', '[택배사]'], 'i') + '<div class="brow"><button class="b " type="button">송장 일괄 입력</button><button class="b pri" type="button">선택 발송 처리</button></div></div>'
body25b = (mph('배송', '주문 › 배송 · 송장 › 배송', ACTS25) + '<div class="body">' + RT25 + '<div class="box">'
           + f1('기간', PRE + sel(['개봉 완료일', '주문일', '발송일']))
           + f1('배송 상태', radios('ds', ['배송 준비', '배송 중', '배송 완료', '전체']))
           + f1('택배사', sel(['전체', '[택배사]']))
           + f1('검색어', '<div class="row">' + sel(['닉네임', '받는 분', '송장번호', '상품명'], 'i w-s') + '<input class="i " type="text" value="" placeholder="검색어 입력"></div>')
           + f1('기타', '<div class="cks"><label class="ck"><input type="checkbox" name="r">도서산간만</label></div>') + SBTN + '</div></div>')
CUR = 'SA-025-M'; _ph.clear()
s = (HEAD.format(title='배송 (휴대폰)') + phone('① 탭(배송 준비 / 송장 발급 / 출력 · 추적) · 요약 2×2 · 검색 조건 접힘 · 행 = 카드(주문자 · 상품 · 받는 분 · 주소 · 택배사 · 송장번호 입력) · 「발송 처리」 · 선택하면 아래 띠에 택배사 일괄 지정 · 송장 일괄 입력 · 선택 발송', 2700, body25a, bar25)
     + phone('② 검색 조건 펼침 · 1열 · 기간 기준(개봉 완료일 · 주문일 · 발송일) · 「검색 · 초기화」 폭 전체', 1900, body25b) + TAIL.format(h=H.get(CUR + '/preview', 2750)))
wr('SA-025-M.dc.html', s)
