#!/usr/bin/env python3
"""보드 반영 묶음 21 — 휴대폰(390) 보드 2단계 (MASTER (4) 승인 순서 2 · ID 정정: 방송 대시보드는 SA-001-M1~M6 기존 · SA-051 편집기는 PC 전용).
SA-052-M 방송 프로그램에 넣기(주소 2종 복사 · OBS 추가 방법 · 재발급 · 접속 기록) · SA-053-M HIT 카드 기록(카드 목록 · 갤러리 · 선택 지우기).
틀: SA-FRAME-M + DS-TABLE-CARD(묶음 18 도우미 재사용). 원본: SA-052 v336 · SA-053 v312.
사용: gen-board-sync21.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>"""
import sys, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))
HEAD = ('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<title>{title}</title>\n<script src="./support.js"></script>\n'
        '<link rel="stylesheet" href="ds/wds/tokens.css">\n<link rel="stylesheet" href="lop.css">\n</head>\n<body>\n<x-dc>\n<helmet>\n<style>body{{margin:0}}.c24.mob .m-kv span .tag{{vertical-align:middle}}.c24.mob .m-kvs.one{{grid-template-columns:1fr}}.c24.mob .m-kvs.one .m-kv b{{width:72px}}.c24.mob .m-kvs.one .m-kv span{{white-space:normal;flex:1}}.c24.mob .m-kvs.one .m-kv span>.i{{width:100%;box-sizing:border-box}}.c24.mob .sum.g2{{grid-auto-flow:row;grid-template-columns:1fr 1fr}}.c24.mob .sum.g2>div:nth-child(-n+2){{border-bottom:1px solid var(--c24-line2)}}.c24.mob .sum.g2>div:nth-child(2n){{border-right:0}}.c24.mob .m-bar.wrap{{flex-wrap:wrap}}.c24.mob .m-bar .brow{{display:flex;gap:8px;width:100%}}.c24.mob .m-bar .brow .i{{height:48px;flex:1;min-width:0}}</style>\n</helmet>\n'
        '<div class="app c24 mob" data-theme="light" style="width: 884px">\n<div class="mobs">')
TAIL = ('</div>\n</div>\n</x-dc>\n<script type="text/x-dc" data-dc-script data-props=\'{{"$preview":{{"width":884,"height":{h}}}}}\'>\n'
        'class Component extends DCLogic {{ renderVals() {{ return {{}}; }} }}\n</script>\n</body>\n</html>\n')
TOP = ('<div class="top"><button class="mn" type="button" aria-label="메뉴"><i></i><i></i><i></i></button><a class="brand" href="SA-002.dc.html">'
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


CFM_STYLE = '.c24 .cfm{position:relative}.c24.mob .m-ph .cfm{margin:0 16px 16px;width:auto;max-width:none;min-width:0;box-sizing:border-box}'
def note(cls, t): return f'<div class="note {cls}">{t}</div>'
def hint(t): return f'<span class="hint" style="margin: 0">{t}</span>'
URL = '<input class="i w-f" type="text" value="https://ov.onq.live/••••••••••••" placeholder="방송 화면 주소" readonly>'

# ---------- SA-052-M 방송 프로그램에 넣기 (SA-052 v336) ----------
CUR = 'SA-052-M'; _ph.clear()
RT52 = '<div class="rtabs"><a class="" href="SA-051.dc.html">편집기</a><a class="on" href="SA-052-M.dc.html">방송 프로그램에 넣기</a></div>'
addr = ('<div class="m-card"><div class="hd"><div class="nm"><a href="#">방송 프로그램에 넣기 주소</a><small>' + tag('연결됨', 'g') + ' OBS 30.1</small></div></div>'
        '<div class="m-kvs one">' + f1('세로형 1080×1920 (9:16)', URL + '<button class="b pri w-f" type="button" style="margin-top: 8px">복사</button>' + hint('모바일 시청 · 하단 주문대기'))
        + f1('가로형 1920×1080 (16:9)', URL + '<button class="b w-f" type="button" style="margin-top: 8px">복사</button>' + hint('PC 시청 · 아래 주문대기 띠')) + '</div>'
        + '<span class="hint" style="padding: 0 12px 10px; display: block">주소는 만들 때 한 번만 보입니다 · 다시 보려면 「재발급」으로 새 주소를 받습니다(기존 주소는 바로 쓸 수 없게 됩니다) · 발급 2026.08.02 · 마지막 접속 방금 전 (OBS, 1개 소스)</span></div>')
steps = [('1', 'OBS › 소스 › <b>+ 브라우저</b> 선택 후 이름 입력 (예: ONQ 주문대기)'), ('2', 'URL에 위 주소를 붙여넣고 <b>너비 1080 · 높이 1920</b> (가로형은 1920 · 1080)을 넣습니다'),
         ('3', '「소스가 보이지 않을 때 종료」 <b>해제</b>, 「OBS로 오디오 제어」 해제'), ('4', '방송 대시보드에서 「방송 시작」을 누르면 방송 화면이 LIVE로 바뀌는지 확인합니다')]
obs = kvbox('OBS에 추가하는 방법', steps, '<div style="padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px"><button class="b w-f" type="button">OBS 소스 설정 파일 내려받기</button><a href="SA-114.dc.html" class="hint" style="margin: 0">연결이 안 되면 문의</a></div>')
reissue = ('<div class="m-card"><div class="hd"><div class="nm"><a href="#">주소 재발급</a><small>주소가 유출됐거나 직원이 퇴사했을 때</small></div></div>'
           '<div style="padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px">' + hint('기존 주소는 즉시 무효화되고 OBS 소스를 새 주소로 바꿔야 합니다')
           + note('cau', '<b>방송 중에는 재발급할 수 없습니다.</b> 방송 종료 후 진행해 주십시오 (현재: 방송 중)') + '<button class="b dis w-f" type="button" disabled>재발급</button></div></div>')
hist = kvbox('재발급 이력', [('8/02', '최초 발급 · 카드숍 별빛')])
conn = ('<div class="m-card"><div class="hd"><div class="nm"><a href="#">접속 기록</a><small>낯선 접속이 보이면 재발급해 주십시오</small></div></div><div class="m-kvs one">'
        + ''.join(f'<div class="m-kv"><b>{t}</b><span>{s} · {l} {tg}</span></div>' for t, s, l, tg in [('10.02 13:14', 'OBS 30.1 · Windows', '세로형', tag('연결 중', 'g')), ('10.01 19:58', 'OBS 30.1 · Windows', '세로형', tag('종료', 'n')), ('09.29 20:01', 'Chrome · macOS', '가로형', tag('미확인 브라우저', 'y'))])
        + '</div></div>')
body52a = (mph('방송 프로그램에 넣기', '방송 › 방송 화면 꾸미기 › 방송 프로그램에 넣기') + '<div class="body">' + RT52
           + note('cau', '파트너스 전용 비공개 주소입니다 · 이 주소를 아는 사람은 누구나 주문대기를 볼 수 있으니 방송 화면에 노출하지 마십시오')
           + '<div class="m-cards">' + addr + obs + reissue + hist + conn + '</div></div>')
CFM52 = ('<div class="cfm"><div class="h">주소를 재발급하시겠습니까?<button class="x" type="button" aria-label="닫기">×</button></div>'
         '<div class="bd"><b>기존 OBS 주소는 바로 끊깁니다.</b> OBS 소스 1개를 새 주소로 바꿔야 합니다.<label class="ck" style="margin-top: 12px"><input type="checkbox" name="r">확인했습니다</label></div>'
         '<div class="f"><button class="b" type="button">취소</button><button class="b neg pri dis" type="button" disabled>재발급</button></div></div>')
body52b = (mph('방송 프로그램에 넣기', '방송 › 방송 화면 꾸미기 › 방송 프로그램에 넣기') + '<div class="body">' + RT52
           + note('inf', '<b>이 주소는 지금만 볼 수 있습니다.</b> OBS에 넣은 뒤 잃어버리면 재발급해 주십시오.')
           + '<div class="m-cards"><div class="m-card"><div class="hd"><div class="nm"><a href="#">방송 프로그램에 넣기 주소</a><small>' + tag('발급 직후', 'y') + ' 창을 닫으면 다시 가려집니다</small></div></div><div class="m-kvs one">'
           + f1('세로형 1080×1920 (9:16)', '<input class="i w-f" type="text" value="https://ov.onq.live/k7d2-9f31-ab44-c0e7" readonly><button class="b pri w-f" type="button" style="margin-top: 8px">복사</button>')
           + f1('가로형 1920×1080 (16:9)', '<input class="i w-f" type="text" value="https://ov.onq.live/k7d2-9f31-ab44-c0e7?w" readonly><button class="b w-f" type="button" style="margin-top: 8px">복사</button>') + '</div>'
           + '<span class="hint" style="padding: 0 12px 10px; display: block">접속 기록에 「발급」이 남습니다</span></div></div>'
           + '<div class="toast">방송 프로그램에 넣기 주소를 복사했습니다</div>'
           + '<div class="m-cards"><div class="m-card"><div class="hd"><div class="nm"><a href="#">미연결</a><small>' + tag('미연결', 'n') + ' 아직 OBS에서 접속한 적이 없습니다</small></div></div><span class="hint" style="padding: 0 12px 10px; display: block">접속 기록이 비어 있고 「OBS에 추가하는 방법」이 강조됩니다</span></div></div>'
           + '</div>' + CFM52)
s = (HEAD.format(title='방송 프로그램에 넣기 (휴대폰)').replace('</style>', CFM_STYLE + '</style>')
     + phone('① 비공개 주소 안내 띠 · 주소 2종(복사 버튼 폭 전체) · OBS 추가 4단계 · 재발급(방송 중 잠김) · 재발급 이력 · 접속 기록(1열 항목 칸) · 탭 「편집기」는 PC 전용 안내로 이동', 2400, body52a)
     + phone('② 발급 직후 주소 1회 노출 · 복사 토스트 · 미연결 상태 · 재발급 확인 창(DS-CONFIRM ④ 위험 · 확인 체크 뒤 활성)', 1600, body52b) + TAIL.format(h=H.get(CUR + '/preview', 2450)))
wr('SA-052-M.dc.html', s)

# ---------- SA-053-M HIT 카드 기록 (SA-053 v312) ----------
CUR = 'SA-053-M'; _ph.clear()
ACTS53 = '<button class="b " type="button">내보내기</button><button class="b pri" type="button">HIT 카드 기록하기</button>'
RT53 = '<div class="rtabs"><a class="" href="SA-054.dc.html">방송별</a><a class="on" href="SA-053-M.dc.html">HIT 카드</a></div>'
TH = '<span style="display: inline-block; width: 24px; height: 32px; background: linear-gradient(135deg, #5b3df6, #3b1fb8); vertical-align: middle; margin-right: 8px"></span>'
def hit(name, pack, when, grade, buyer, order, live, shown, sel_=False):
    return card(TH + name, f'{pack} · {when}', tag(grade, 'bl'), [('구매자', buyer), ('주문', order), ('방송', live), ('방송 화면', tag(shown, 'g' if shown == '노출 완료' else 'n'))],
                '<button class="b sm" type="button">다시 연출</button><a class="b sm" href="SA-055.dc.html">상세</a>', sel=sel_, href='SA-055.dc.html', one=True)
cards53 = (hit('홀로그램 피닉스 풀아트', '스타라이트', '10.02 14:03', 'SAR', '별빛사냥꾼', '14:12 접수', '10.02 브레이크', '노출 완료', True)
           + hit('피카츄 ex', '스타라이트', '10.02 13:58', 'SR', '초보수집가', '14:11 접수', '10.02 브레이크', '노출 완료')
           + hit('루피 리더 패러렐', '문라이트', '10.01 21:40', 'L-P', '오로라드래곤', '10.01 13:21 접수', '10.01 브레이크', '노출 완료')
           + hit('뮤 ex SAR', '스타라이트', '10.01 20:30', 'SAR', '푸른고래', '10.01 13:00 접수', '10.01 브레이크', '노출 생략'))
body53a = (mph('HIT 카드 기록', '방송 › 방송 기록 › HIT 카드 기록', ACTS53) + '<div class="body">' + RT53
           + fold('검색 조건', '최근 1개월 · 방송 전체 · 등급 전체')
           + '<div class="sort"><span class="nt">총 <b>128</b></span><div class="seg" style="margin-left: auto"><button class="on" type="button">목록</button><button class="" type="button">갤러리</button></div></div>'
           + '<div class="m-cards">' + cards53 + '</div>' + PG + hint('방송 중 등록한 당첨 카드입니다 · 구매자 주문 상세와 쇼핑몰 「HIT 갤러리」(선택)에 표시됩니다') + '</div>')
bar53 = '<div class="m-bar"><span class="n">1개 선택</span><button class="b neg" type="button">선택한 카드 지우기</button></div>'
def gcell(name, who): return f'<div class="box" style="padding: 6px"><div style="height: 140px; background: linear-gradient(135deg, #5b3df6, #3b1fb8)"></div><div style="font-size: 13px; font-weight: 700; margin-top: 6px">{name}</div><div class="nt">{who}</div></div>'
gal = '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + ''.join(gcell(n, w) for n, w in [('홀로그램 피닉스 풀아트', '별빛사냥꾼'), ('피카츄 ex', '초보수집가'), ('루피 리더 패러렐', '오로라드래곤'), ('블루아이즈 시크릿', '카드왕')]) + '</div>'
CFM53 = ('<div class="cfm"><div class="h">이 HIT 카드를 지우시겠습니까?<button class="x" type="button" aria-label="닫기">×</button></div>'
         '<div class="bd">방송 화면에서도 바로 사라집니다. 지운 카드는 되살릴 수 없습니다.</div>'
         '<div class="f"><button class="b" type="button">취소</button><button class="b neg pri" type="button">카드 지우기</button></div></div>')
body53b = (mph('HIT 카드 기록', '방송 › 방송 기록 › HIT 카드 기록', ACTS53) + '<div class="body">' + RT53
           + '<div class="box">' + f1('방송', sel(['전체', '2026.10.02 브레이크', '2026.10.01 브레이크', '2026.09.29 브레이크'])) + f1('등급', sel(['전체', 'SAR', 'SR', 'UR', 'SE', 'SP', 'AA'])) + f1('기간', PRE) + SBTN + '</div>'
           + '<div class="sort"><span class="nt">총 <b>128</b></span><div class="seg" style="margin-left: auto"><button class="" type="button">목록</button><button class="on" type="button">갤러리</button></div></div>'
           + gal + '</div>' + CFM53)
s = (HEAD.format(title='HIT 카드 기록 (휴대폰)').replace('</style>', CFM_STYLE + '</style>')
     + phone('① 탭(방송별 / HIT 카드) · 검색 조건 접힘 · 총 건수 + 목록/갤러리 전환 · 행 = 카드(카드명 · 팩 · 일시 · 등급 · 구매자 · 주문 · 방송 · 방송 화면) · 「다시 연출」 「상세」 · 선택하면 아래 띠에 「선택한 카드 지우기」', 2300, body53a, bar53)
     + phone('② 검색 조건 펼침(방송 · 등급 · 기간) · 갤러리 2열 · 카드 지우기 확인 창(DS-CONFIRM ④ 위험)', 2000, body53b) + TAIL.format(h=H.get(CUR + '/preview', 2350)))
wr('SA-053-M.dc.html', s)
