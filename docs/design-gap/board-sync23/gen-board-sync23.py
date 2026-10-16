#!/usr/bin/env python3
"""보드 반영 묶음 23 — 휴대폰(390) 보드 3단계 뒷부분(MASTER (4) 승인 순서 3): SA-002-M 파트너스 홈(SA-002-IA: 오늘 처리할 일 → 오늘 성과 → 방송) · SA-012-M 상품 보기(읽기 전용 · 품절 전환만, 수정은 PC).
틀: SA-FRAME-M + DS-TABLE-CARD(묶음 18 도우미 재사용). 원본: SA-002-IA v300 · SA-012 v337 · SA-011-M v336(예시 상품).
사용: gen-board-sync23.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>"""
import sys, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
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


CFM_STYLE = ('.c24 .cfm{position:relative}.c24.mob .m-ph .cfm{margin:0 16px 16px;width:auto;max-width:none;min-width:0;box-sizing:border-box}.c24.mob .m-kvs.one .m-kv b{width:var(--kw,72px)}'
             '.c24.mob .todo{display:flex;flex-direction:column;gap:8px}.c24.mob .todo a{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--c24-line);border-radius:8px;background:#fff;text-decoration:none;color:inherit}.c24.mob .todo a.hot{border-color:#f0b4b4;background:#fff8f8}'
             '.c24.mob .todo .v{font-size:22px;font-weight:800;min-width:56px}.c24.mob .todo .k{font-weight:700;font-size:14px}.c24.mob .todo .nt{display:block;font-size:12px}.c24.mob .todo .ar{margin-left:auto;color:var(--c24-sub)}'
             '.c24.mob .img{display:flex;gap:8px;overflow-x:auto}.c24.mob .img span{flex:none;width:96px;height:96px;border-radius:8px;background:var(--c24-th);border:1px solid var(--c24-line);box-sizing:border-box}.c24.mob .img span.main{outline:2px solid var(--c24-acc);outline-offset:-2px}')
def note(cls, t): return f'<div class="note {cls}">{t}</div>'
def hint(t): return f'<span class="hint" style="margin: 0">{t}</span>'
def box(inner): return '<div class="box">' + inner + '</div>'

# ---------- SA-002-M 파트너스 홈 (SA-002-IA v300) ----------
CUR = 'SA-002-M'; _ph.clear()
ACTS2 = '<a class="b " href="SH-001.dc.html">쇼핑몰 보기</a><a class="b pri" href="SA-001-M1.dc.html">방송 대시보드</a>'
def todo(k, v, nt, href, hot=False):
    return f'<a class="{"hot" if hot else ""}" href="{href}"><span class="v">{v}</span><span><span class="k">{k}</span><span class="nt">{nt}</span></span><span class="ar">›</span></a>'
todos = ('<div class="todo">' + todo('입금 확인 필요', '4건', '입금 전 · 2일 넘음 1건', 'SA-021-M.dc.html', True) + todo('배송 준비 필요', '7건', '송장 입력 전', 'SA-025-M.dc.html', True)
         + todo('문의 답변 필요', '3건', '오래된 문의 1일 전', 'SA-111.dc.html') + todo('재고 부족 상품', '5개', '품절 임박 · 품절 1개', 'SA-014.dc.html', True)
         + todo('반품 요청 답변 필요', '2건', '처리 기한 3일 남음', 'SA-023-M.dc.html') + '</div>')
perf = ('<div class="sum g2"><div><div class="k">결제된 매출</div><div class="v">2,142,000원<small><span class="dl p"><b>▲</b> 12.4%</span> 어제 같은 시각 1,906,000원</small></div></div>'
        '<div><div class="k">오늘 주문</div><div class="v">24건<small><span class="dl p"><b>▲</b> 9.1%</span> 취소 · 환불 제외</small></div></div>'
        '<div><div class="k">주문 1건당 평균</div><div class="v">89,250원<small><span class="dl m"><b>▼</b> 2.2%</span> 어제 91,300원</small></div></div>'
        '<div><div class="k">취소·환불 건수</div><div class="v">3건<small>환불 1건 · 취소 2건</small></div></div></div>')
lives = (card('10/2 스타라이트 · 문라이트 브레이크', '20:00 ~', tag('진행 중', 'live'), [('주문', '24건'), ('매출', '2,142,000원')], '<a class="b sm pri" href="SA-001-M1.dc.html">방송 보기</a>', check=False, href='SA-001-M1.dc.html')
         + card('10/4 드래곤 소울 개봉', '2026.10.04 20:00', tag('예정', 'n'), [('주문', '—'), ('매출', '—')], '<a class="b sm" href="SA-001-M1.dc.html">준비하기</a>', check=False, href='SA-001-M1.dc.html')
         + card('10/1 드래곤 소울 개봉', '2026.10.01 20:00 ~ 22:10', tag('종료', 'n'), [('주문', '61건'), ('매출', '4,600,000원')], '<a class="b sm" href="SA-055.dc.html">결과 보기</a>', check=False, href='SA-055.dc.html'))
def sech(t, nt, act=''): return f'<div class="sec-h" style="display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap"><h2 style="margin: 0; font-size: 16px">{t}</h2><span class="nt">{nt}</span>{act}</div>'
body2a = (mph('홈', '홈 › 홈', ACTS2) + '<div class="body">'
          + sech('오늘 처리할 일', '숫자를 누르면 그 목록으로 · 10/2 (금) 21:12 집계') + todos
          + sech('오늘 성과', '결제 완료 기준 · 어제 같은 시각 대비', '<a class="b sm" href="SA-056.dc.html" style="margin-left: auto">분석 자세히</a>') + perf
          + sech('방송', '진행 · 예정 · 최근 종료', '<a class="b sm" href="SA-054.dc.html" style="margin-left: auto">방송 이력</a>') + '<div class="m-cards">' + lives + '</div></div>')
body2b = (mph('홈', '홈 › 홈', ACTS2) + '<div class="body">'
          + sech('오늘 처리할 일', '10/2 (금) 21:12 집계') + note('inf', '지금 처리할 일이 없습니다. 새 주문이 들어오면 여기에 표시됩니다.') + '<a class="b w-f" href="SA-001-M1.dc.html">방송 대시보드</a>'
          + sech('오늘 성과', '직원 권한 없음') + note('cau', '매출 · 성과는 대표자와 통계 권한이 있는 직원에게만 표시됩니다. 처리할 일은 내 권한에 해당하는 항목만 보입니다.') + '<button class="b w-f" type="button">대표자에게 권한 요청</button>'
          + sech('방송', '없음') + note('inf', '진행 · 예정 방송이 없습니다. 방송 대시보드에서 첫 방송을 시작해 주십시오.')
          + note('neg', '<b>집계를 불러오지 못했습니다.</b> 네트워크를 확인한 뒤 다시 시도해 주십시오.') + '<button class="b w-f" type="button">다시 시도</button></div>')
s = (HEAD.format(title='홈 (휴대폰)').replace('</style>', CFM_STYLE + '</style>')
     + phone('① 오늘 처리할 일(한 줄 = 숫자 + 항목 + 보조, 누르면 목록) → 오늘 성과 2×2 → 방송 카드(진행 · 예정 · 종료) · 머리 「쇼핑몰 보기」 「방송 대시보드」 · 정보 순서는 SA-002-IA와 같음', 1700, body2a)
     + phone('② 처리할 일 없음 · 성과 직원 권한 없음(권한 요청) · 방송 없음 · 집계 오류', 1200, body2b) + TAIL.format(h=H.get(CUR + '/preview', 1750)))
wr('SA-002-M.dc.html', s)

# ---------- SA-012-M 상품 보기 (SA-012 v337 읽기 · 품절 전환, 예시 SA-011-M) ----------
CUR = 'SA-012-M'; _ph.clear()
imgs = '<div class="img"><span class="main"></span><span></span><span></span></div>' + hint('썸네일 1 · 이미지 3 / 5 · 순서 · 올리기는 PC에서')
body12a = (mph('상품 보기', '상품 › 상품 목록 › 상품 보기', '', back='SA-011-M.dc.html') + '<div class="body">'
           + note('inf', '휴대폰에서는 상품을 확인하고 품절 · 판매 재개만 바꿀 수 있습니다 · 내용 수정은 PC 「상품 등록 · 수정」에서')
           + '<div class="m-cards">' + '<div class="m-card"><div class="hd"><div class="nm"><a href="#">스타라이트 부스터 박스</a><small>36팩 · 일반 · SP-1001</small></div>' + tag('판매 중', 'g') + '</div><div style="padding: 0 12px 12px">' + imgs + '</div></div>'
           + kvbox('기본 정보', [('상품명', '스타라이트 부스터 박스'), ('카테고리', '게임 › 포켓몬 · 형태 › 부스터 박스'), ('상품 코드', 'SP-1001'), ('짧은 설명', '스타라이트 시리즈 첫 번째 부스터 박스')])
           + kvbox('가격 · 재고', [('판매가', '<b>89,100원</b> · 부가세 포함'), ('정가', '99,000원 (할인 표시)'), ('판매 방식', '일반'), ('재고 수량', '124개 · 0이 되면 자동 품절'), ('1인 구매 제한', '제한 없음'), ('재고 차감', '결제하면 차감'), ('품절 표시', '품절돼도 쇼핑몰에 보임 · 재입고 알림 버튼 표시')])
           + kvbox('이벤트 할인', [('할인', '사용 안 함')])
           + kvbox('옵션', [('옵션', '없음')])
           + kvbox('노출 · 방송', [('쇼핑몰 노출', '노출'), ('방송 주문대기', '대상'), ('오픈 타이머', '기본값 사용 (60초)'), ('등록일', '2026-09-20')])
           + '<div class="m-card"><div class="hd"><div class="nm"><a href="#">상세 설명</a><small>구매자 상품 상세 「상세 정보」 탭</small></div></div><div style="padding: 0 12px 12px"><a class="b w-f" href="SA-013.dc.html">미리보기로 보기</a></div></div>'
           + '</div></div>')
bar12 = '<div class="m-bar save"><a class="b" href="SA-013.dc.html">미리보기</a><button class="b neg" type="button">품절로 전환</button></div>'
CFM12 = ('<div class="cfm"><div class="h">「스타라이트 부스터 박스」를 품절로 전환하시겠습니까?<button class="x" type="button" aria-label="닫기">×</button></div>'
         '<div class="bd">쇼핑몰에 「품절」로 표시되고 새 주문을 받지 않습니다 · 방송 주문대기에서도 빠집니다 · 재고 수량(124개)은 그대로 둡니다 · 「판매 재개」로 되돌릴 수 있습니다</div>'
         '<div class="f"><button class="b" type="button">취소</button><button class="b neg pri" type="button">품절로 전환</button></div></div>')
body12b = (mph('상품 보기', '상품 › 상품 목록 › 상품 보기', '', back='SA-011-M.dc.html') + '<div class="body">'
           + '<div class="m-cards"><div class="m-card"><div class="hd"><div class="nm"><a href="#">스타라이트 부스터 박스</a><small>36팩 · 일반 · SP-1001</small></div>' + tag('품절', 'r') + '</div>'
           + '<div class="m-kvs one"><div class="m-kv"><b>재고 수량</b><span>124개 · 품절 전환으로 판매 중지</span></div><div class="m-kv"><b>전환</b><span>10.02 21:30 · [대표자명]</span></div></div></div></div>'
           + '<div class="toast">품절로 전환했습니다 · 쇼핑몰과 방송 화면에 바로 반영됩니다</div>'
           + note('cau', '<b>재고 0 · 자동 품절</b> 상태입니다 · 판매를 재개하려면 PC에서 재고를 먼저 넣어 주십시오') + '<button class="b dis w-f" type="button" disabled>판매 재개</button>'
           + note('inf', '직원(상품 권한 없음)에게는 「품절로 전환」 「판매 재개」가 보이지 않습니다 · 필요한 권한: 상품 관리')
           + '</div>' + CFM12)
bar12b = '<div class="m-bar save"><a class="b" href="SA-013.dc.html">미리보기</a><button class="b pri" type="button">판매 재개</button></div>'
s = (HEAD.format(title='상품 보기 (휴대폰)').replace('</style>', CFM_STYLE + '</style>')
     + phone('① 읽기 전용 상품 보기(이미지 띠 · 기본 정보 · 가격 · 재고 · 할인 · 옵션 · 노출 · 방송 1열 항목 칸) · 수정은 PC 안내 · 아래 고정 띠 [미리보기][품절로 전환]', 2100, body12a, bar12)
     + phone('② 품절 전환 확인 창(DS-CONFIRM ④) · 전환 뒤 상태(품절 배지 · 토스트 · 띠 「판매 재개」) · 재고 0 자동 품절(재개 잠김) · 직원 권한 없음', 1300, body12b, bar12b) + TAIL.format(h=H.get(CUR + '/preview', 2150)))
s = s.replace('<div class="m-kvs one">', '<div class="m-kvs one" style="--kw: 96px">')
wr('SA-012-M.dc.html', s)
