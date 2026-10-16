#!/usr/bin/env python3
"""보드 반영 묶음 22 — 휴대폰(390) 보드 3단계 앞부분(MASTER (4) 승인 순서 3 · 문의 · 계정): SA-113-M 내 문의(목록 · ② 문의 상세 SA-115 대화) · SA-114-M 문의하기(1열 폼 · ② 접수 완료 · 나가기 확인) · SA-120-M 내 계정(프로필 · 비밀번호 변경 · ② 오류 · 완료 · 시도 제한).
틀: SA-FRAME-M + DS-TABLE-CARD(묶음 18 도우미 재사용). 원본: SA-113 v310 · SA-114 v337 · SA-115 v30x · SA-120 v336.
사용: gen-board-sync22.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>"""
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


CFM_STYLE = '.c24 .cfm{position:relative}.c24.mob .m-ph .cfm{margin:0 16px 16px;width:auto;max-width:none;min-width:0;box-sizing:border-box}.c24.mob .msgb{border:1px solid var(--c24-line);border-radius:8px;padding:12px;background:#fff}.c24.mob .msgb.me{background:#f5f7fb}.c24.mob .msgb .who{font-size:12px;color:var(--c24-sub);margin-bottom:6px}.c24.mob .msgb .who b{color:var(--c24-ink)}.c24.mob .msgb p{margin:0;font-size:14px;line-height:21px}.c24.mob .m-kvs.one .m-kv b{width:var(--kw,72px)}'
def note(cls, t): return f'<div class="note {cls}">{t}</div>'
def hint(t): return f'<span class="hint" style="margin: 0">{t}</span>'
def box(inner): return '<div class="box">' + inner + '</div>'
KINDS = ['방송 화면', '결제 연결', '주문 · 환불', '적립금', '구독 · 요금', '쇼핑몰', '계정 · 직원', '기타']

# ---------- SA-113-M 내 문의 (SA-113 v310 · ② SA-115) ----------
CUR = 'SA-113-M'; _ph.clear()
def inq(title, kind, when, last, st, c, new=False, href='#'):
    return card(title + (' ' + tag('새 답변', 'r') if new else ''), f'{kind} · {when}', tag(st, c), [('마지막 글', last)], check=False, href=href, one=True)
cards113 = (inq('방송 중 방송 화면이 가끔 멈춥니다 (21:03 끊김)', '방송 화면', '2026.10.02', '2026.10.02 15:20', '답변 완료', 'g', True)
            + inq('가상계좌 입금 통보가 늦게 들어옵니다', '결제 연결', '2026.10.01', '—', '접수', 'bl')
            + inq('세금계산서 사업자 정보 변경 요청', '구독 · 요금', '2026.09.26', '2026.09.27 11:02', '종료', 'n')
            + inq('실제 지급 켠 뒤 대기분이 일부만 반영됨', '적립금', '2026.09.20', '2026.09.21 09:40', '종료', 'n')
            + inq('내 도메인 연결 일정 문의', '쇼핑몰', '2026.09.15', '2026.09.15 16:10', '종료', 'n'))
body113a = (mph('내 문의', '공지 · 문의 › 내 문의', '<a class="b pri" href="SA-114-M.dc.html">문의하기</a>') + '<div class="body">'
            + chips([('전체', 9, ' on'), ('접수', 1, ''), ('답변 완료', 1, ' hot'), ('종료', 7, '')])
            + '<div class="sort">' + sel(['문의 종류 전체'] + KINDS) + '</div>'
            + '<div class="m-cards">' + cards113 + '</div>' + PG + hint('평균 첫 답변 4시간 (평일 10~18시)') + '</div>')
def msg(who, when, body, me=False, extra=''):
    return f'<div class="msgb{" me" if me else ""}"><div class="who"><b>{who}</b> · {when}</div><p>{body}</p>{extra}</div>'
body113b = (mph('문의 상세', '공지 · 문의 › 내 문의 › 상세', '', back='SA-113-M.dc.html') + '<div class="body">'
            + '<div class="box" style="padding: 12px 14px"><div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px">' + tag('답변 완료', 'g') + tag('담당자 배정됨', 'bl') + '</div><b style="font-size: 15px">방송 중 방송 화면이 가끔 멈춥니다 (21:03 끊김)</b><div class="nt" style="margin-top: 4px">방송 화면 · 2026.10.02 14:35 보냄 · 관련: 2026.10.02 방송</div></div>'
            + '<div style="display: flex; flex-direction: column; gap: 8px">'
            + msg('카드숍 별빛', '10.02 14:35', '어제 방송(10/1) 21:03쯤 방송 화면이 40초 정도 멈췄다가 돌아왔습니다. 관리자 화면에는 「재연결 중」이 떴습니다. OBS 30.1, 윈도우 11입니다.', True, '<div class="nt" style="margin-top: 6px">첨부 obs-log.txt · 진단 정보 자동 첨부</div>')
            + msg('ONQ 운영팀', '10.02 15:20', '첨부해 주신 로그와 접속 기록을 확인했습니다. 10/1 21:03:11에 실시간 서버 측 재배포로 42초간 연결이 끊긴 기록이 있으며, 파트너스님 환경 문제는 아닙니다. 10월 5일(월) 점검에서 무중단 배포로 전환됩니다. 1분 이상 지속되면 OBS 소스를 새로고침해 주십시오.')
            + '</div>'
            + box(f1('답변이 도움이 됐습니까?', '<div class="row"><button class="b" type="button" style="flex: 1">도움됨</button><button class="b" type="button" style="flex: 1">아니요</button></div>'))
            + box(f1('추가 문의 보내기', '<textarea class="i w-f" placeholder="추가로 궁금한 내용을 적어 주십시오"></textarea><div class="row" style="margin-top: 8px"><button class="b" type="button">사진 첨부</button><button class="b pri" type="button" style="flex: 1">추가 문의 보내기</button></div>'))
            + kvbox('처리 이력', [('15:20', '답변 완료 · ONQ 운영팀'), ('14:40', '담당자 배정됨'), ('14:35', '문의 보냄')])
            + kvbox('관련 공지', [('공지', '<a href="SA-112.dc.html">10월 5일(월) 서비스 점검 안내</a>')]) + '</div>')
bar113b = '<div class="m-bar save"><button class="b" type="button">해결됐습니다 · 종료</button></div>'
s = (HEAD.format(title='내 문의 (휴대폰)').replace('</style>', CFM_STYLE + '</style>')
     + phone('① 상태 칩(전체 · 접수 · 답변 완료 · 종료) · 문의 종류 선택 · 행 = 카드(제목 · 종류 · 작성일 · 마지막 글 · 상태, 새 답변 배지) · 「문의하기」는 머리 버튼', 1700, body113a)
     + phone('② 문의 상세(SA-115 내용) · 상태 칩 · 대화 말풍선(내 글은 옅은 배경) · 도움됨 · 추가 문의 · 처리 이력 · 아래 고정 띠 「해결됐습니다 · 종료」', 2200, body113b, bar113b) + TAIL.format(h=H.get(CUR + '/preview', 2250)))
wr('SA-113-M.dc.html', s)

# ---------- SA-114-M 문의하기 (SA-114 v337) ----------
CUR = 'SA-114-M'; _ph.clear()
kinds = '<div class="chips" style="display: flex; flex-wrap: wrap; gap: 6px">' + ''.join(f'<button class="chip{" on" if i == 0 else ""}" type="button">{k}</button>' for i, k in enumerate(KINDS)) + '</div>'
body114a = (mph('문의하기', '공지 · 문의 › 내 문의 › 문의하기', '', back='SA-113-M.dc.html') + '<div class="body"><div class="box">'
            + f1('문의 종류 <span class="rq">*</span>', kinds + note('inf', '<b>방송 화면이 멈출 때</b> · 먼저 확인: OBS 브라우저 소스 새로고침 → 방송 화면 연결 상태 확인 → 그래도 안 되면 아래에 방송 시각을 적어 주십시오'))
            + f1('제목 <span class="rq">*</span>', '<input class="i w-f" type="text" value="" placeholder="제목"><span class="hint" style="margin: 0">0 / 80</span>')
            + f1('문의 내용 <span class="rq">*</span>', '<textarea class="i w-f" style="min-height: 140px" placeholder="무슨 일이 있었는지, 언제 생겼는지 적어 주십시오"></textarea>')
            + f1('관련 주문 · 방송 (선택)', sel(['선택 안 함', '2026.10.02 방송 「스타라이트 · 문라이트 브레이크」', '2026.10.02 14:10 주문 · 밤하늘']))
            + f1('첨부 사진 (선택)', '<button class="b w-f" type="button">파일 선택</button>' + hint('최대 5개 · 20MB · 스크린샷 · OBS 로그 권장'))
            + f1('함께 보낼 진단 정보', '<label class="ck"><input type="checkbox" name="r" checked>진단 정보를 함께 보냅니다</label>' + hint('보낼 때 한 번 모읍니다 · 브라우저 · OS · OBS 버전 · 최근 방송 · 방송 화면 마지막 접속 · 앱 버전'))
            + '</div>' + note('cau', '<b>긴급 (방송 중 장애)</b> · 「방송 화면」 종류 + 제목에 <b>[긴급]</b>을 붙여 주십시오 · 운영팀 알림이 바로 울립니다')
            + hint('평일에는 4시간 안에 첫 답변을 드립니다')
            + kvbox('자주 묻는 질문', [('질문', '<a href="SA-111.dc.html">OBS에서 배경이 검게 나옵니다</a>'), ('질문', '<a href="SA-111.dc.html">가상계좌 입금이 늦게 반영됩니다</a>'), ('질문', '<a href="SA-111.dc.html">실제 지급을 켰는데 잔액이 안 보입니다</a>')]) + '</div>')
bar114 = '<div class="m-bar save"><button class="b" type="button">임시 저장</button><button class="b pri" type="button">문의 보내기</button></div>'
CFM114 = ('<div class="cfm"><div class="h">작성 중인 내용이 사라집니다. 나가시겠습니까?<button class="x" type="button" aria-label="닫기">×</button></div>'
          '<div class="bd">임시 저장을 누르면 내용을 남겨 두고 나갈 수 있습니다.</div><div class="f"><button class="b" type="button">취소</button><button class="b neg pri" type="button">나가기</button></div></div>')
body114b = (mph('문의하기', '공지 · 문의 › 내 문의 › 문의하기', '', back='SA-113-M.dc.html') + '<div class="body">'
            + note('pos', '<b>문의를 보냈습니다</b> · 답변이 오면 알림 센터와 이메일로 알려 드립니다') + '<a class="b pri w-f" href="SA-113-M.dc.html">문의 보기</a>'
            + '<div class="box">' + f1('제목 <span class="rq">*</span>', '<input class="i w-f err" type="text" value="" placeholder="제목"><span class="errt">제목을 입력해 주십시오</span>') + '</div>'
            + note('neg', '<b>obs-log.txt를 올리지 못했습니다.</b> 20MB를 넘었습니다 · 압축하거나 최근 부분만 올려 주십시오')
            + '<div class="toast">작성 중인 내용을 임시 저장했습니다</div>' + hint('나가도 자동으로 저장하고, 다시 오면 이어서 쓸 수 있습니다')
            + '</div>' + CFM114)
s = (HEAD.format(title='문의하기 (휴대폰)').replace('</style>', CFM_STYLE + '</style>')
     + phone('① 1열 폼(문의 종류 칩 2줄 · 제목 · 내용 · 관련 주문 · 첨부 · 진단 정보) · 긴급 안내 · 자주 묻는 질문 · 아래 고정 띠 [임시 저장][문의 보내기]', 2300, body114a, bar114)
     + phone('② 접수 완료 · 입력 오류 · 첨부 오류 · 임시 저장 토스트 · 나가기 확인 창(DS-CONFIRM ③, 뒤로 가기 포함)', 1300, body114b) + TAIL.format(h=H.get(CUR + '/preview', 2350)))
wr('SA-114-M.dc.html', s)

# ---------- SA-120-M 내 계정 (SA-120 v336) ----------
CUR = 'SA-120-M'; _ph.clear()
body120a = (mph('내 계정', '내 계정', '<a class="b" href="AU-002-M.dc.html">로그아웃</a>') + '<div class="body">'
            + kvbox('프로필', [('계정', '<b>카드숍 별빛</b> · 파트너스 (소유자) · 2026.08.02 가입 · byulbit.onq.live'), ('로그인 이메일', 'owner@byulbit.example · 변경은 문의하기로'), ('언어 · 시간대', '한국어 · Asia/Seoul')],
                    '<div style="padding: 0 12px 12px">' + f1('이름', '<input class="i w-f" type="text" value="[대표자명]" placeholder="이름">') + '<button class="b pri w-f" type="button" style="margin-top: 8px">저장</button>' + hint('이름만 저장됩니다 · 바꾼 것이 없거나 비어 있으면 저장할 수 없습니다') + '</div>')
            + '<div class="box">' + f1('현재 비밀번호 <span class="rq">*</span>', '<input class="i w-f" type="password" value="" placeholder="현재 비밀번호">')
            + f1('새 비밀번호 <span class="rq">*</span>', '<input class="i w-f" type="password" value="" placeholder="8자 이상 · 영문과 숫자">' + hint('8자 이상 입력해 주십시오'))
            + f1('새 비밀번호 확인 <span class="rq">*</span>', '<input class="i w-f" type="password" value="" placeholder="새 비밀번호 다시 입력">')
            + '<button class="b w-f" type="button">비밀번호 변경</button>' + hint('변경 시 다른 기기에서 로그아웃됩니다 · 5번 틀리면 15분 동안 시도할 수 없습니다') + '</div>'
            + note('inf', '알림 수신 항목 · 로그인 기기 · 세션 · 다른 기기 모두 로그아웃은 서버 API가 생기면 이 자리에 넣습니다 (후속)') + '</div>')
body120b = (mph('내 계정', '내 계정', '<a class="b" href="AU-002-M.dc.html">로그아웃</a>') + '<div class="body">'
            + '<div class="toast">프로필을 저장했습니다</div>'
            + '<div class="box">' + f1('현재 비밀번호 <span class="rq">*</span>', '<input class="i w-f err" type="password" value="••••••••" placeholder="현재 비밀번호"><span class="errt">현재 비밀번호가 올바르지 않습니다</span>')
            + f1('새 비밀번호 확인 <span class="rq">*</span>', '<input class="i w-f err" type="password" value="••••••••" placeholder="새 비밀번호 다시 입력"><span class="errt">새 비밀번호와 같지 않습니다</span>') + '</div>'
            + note('pos', '<b>비밀번호를 변경했습니다</b> · 다른 기기 · 브라우저의 로그인은 모두 풀립니다 · 현재 · 새 · 확인 칸을 비웁니다')
            + note('neg', '<b>시도가 너무 많습니다.</b> 87초 뒤에 다시 시도할 수 있습니다 · 그동안 입력 칸과 「비밀번호 변경」을 막습니다')
            + '<button class="b dis w-f" type="button" disabled>비밀번호 변경</button>'
            + note('inf', '직원 계정은 프로필 · 비밀번호만 보입니다 · 알림 수신 항목은 역할에 맞게 줍니다') + '</div>')
s = (HEAD.format(title='내 계정 (휴대폰)').replace('</style>', CFM_STYLE + '</style>')
     + phone('① 프로필(1열 항목 칸 · 이름만 저장) · 비밀번호 변경 1열 폼 · 후속 안내(알림 수신 · 로그인 기기 · 세션은 서버 API 뒤) · 머리 「로그아웃」은 확인 창(DS-CONFIRM ⑦)', 1600, body120a)
     + phone('② 저장 완료 토스트 · 비밀번호 오류 · 확인 불일치 · 변경 완료 · 시도 제한(429, 버튼 잠김) · 직원 계정 보기', 1200, body120b) + TAIL.format(h=H.get(CUR + '/preview', 1650)))
s = s.replace('<div class="m-kvs one">', '<div class="m-kvs one" style="--kw: 96px">', 1)
wr('SA-120-M.dc.html', s)
