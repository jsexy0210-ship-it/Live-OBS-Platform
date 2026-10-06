#!/usr/bin/env python3
"""보드 반영 묶음 4 (디자인 전담 (6), MASTER 추가 배정 2026-10-06):
① 레이아웃 값 이름 「사이드형」→「가로형」(서버 계약 · 방송 화면 편집기 세로 9:16 / 가로 16:9): SA-054 · MA-041 · MA-042 · SA-001-C · SA-001-M5 · SA-052
② SA-034 실제 지급 켜기: 「PG 연결 정상」 조건 삭제 · 전환 이력 「끔 비고」 제거 · 켜기 조건은 안내 · 비활성 표시만
③ PF-007-1 마케팅 선택 동의 「보기」 제거 · PF-007-4 사업자등록증 「(선택)」 · 주소 검색 실패 시 직접 입력 안내(무료 우편번호 서비스 유지)
④ MA-088 플랫폼 정보(마스터 설정) 보드 신규 · canvas.json 등록
사용: gen-board-sync4.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리> (canvas.json 은 현재 publish 된 사본)"""
import sys, re, pathlib, json
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))
COL = '<div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start">'
END = '\n</div>\n</div>\n</x-dc>'

# ── ① 사이드형 → 가로형
s = rd('SA-054.dc.html')
s = rep(s, '<option>세로형</option><option>사이드형</option>', '<option>세로형</option><option>가로형</option>')
s = rep(s, '<td>사이드형</td>', '<td>가로형</td>', 2)
wr('SA-054.dc.html', s)
s = rd('MA-041.dc.html'); s = rep(s, '<td>사이드형</td>', '<td>가로형</td>', 2); wr('MA-041.dc.html', s)
s = rd('MA-042.dc.html'); s = rep(s, '연결 · 사이드형', '연결 · 가로형', 2); wr('MA-042.dc.html', s)
s = rd('SA-001-C.dc.html')
s = rep(s, '세로형 1080×1920 · 모바일 시청</label><label class="ck"><input type="radio" name="lay">가로 사이드형 500×900 · PC 시청</label>',
        '세로형 1080×1920 (9:16) · 모바일 시청</label><label class="ck"><input type="radio" name="lay">가로형 1920×1080 (16:9) · PC 시청</label>')
wr('SA-001-C.dc.html', s)
s = rd('SA-001-M5.dc.html')
s = rep(s, '세로형 1080×1920</label><span class="hint">모바일 시청 · 하단 주문대기</span><label class="ck"><input type="radio" name="lay2">가로 사이드형 500×900</label><span class="hint">PC 시청 · 우측 패널</span>',
        '세로형 1080×1920 (9:16)</label><span class="hint">모바일 시청 · 하단 주문대기</span><label class="ck"><input type="radio" name="lay2">가로형 1920×1080 (16:9)</label><span class="hint">PC 시청 · 아래 주문대기 띠</span>')
wr('SA-001-M5.dc.html', s)
s = rd('SA-052.dc.html')
s = rep(s, '<th>세로형 1080×1920</th>', '<th>세로형 1080×1920 (9:16)</th>')
s = rep(s, '<th>가로 사이드형 500×900</th>', '<th>가로형 1920×1080 (16:9)</th>')
s = rep(s, '<span class="hint">PC 시청 · 우측 패널</span>', '<span class="hint">PC 시청 · 아래 주문대기 띠</span>')
s = rep(s, '<b>너비 1080 · 높이 1920</b> (사이드형은 500 · 900)을 넣습니다', '<b>너비 1080 · 높이 1920</b> (가로형은 1920 · 1080)을 넣습니다')
s = rep(s, '<td>사이드형</td>', '<td>가로형</td>')
wr('SA-052.dc.html', s)
for f in ('SA-054', 'MA-041', 'MA-042', 'SA-001-C', 'SA-001-M5', 'SA-052'):
    assert '사이드형' not in (out / f'{f}.dc.html').read_text(), f

# ── ② SA-034
s = rd('SA-034.dc.html')
s = rep(s, '<tr><td class="l">PG 연결 정상 (회수 처리용)</td><td><span class="tag g">충족</span></td><td class="l"></td></tr>', '')
s = rep(s, '<div class="sec-t">켜기 조건</div>', '<div class="sec-t">켜기 조건<span class="nt">화면 안내와 버튼 비활성 표시용입니다 · 서버가 켜기를 막지는 않습니다</span></div>')
s = rep(s, '<td>카드숍 별빛</td><td class="l">「시즌 종료」</td>', '<td>카드숍 별빛</td><td class="l"></td>')
s = rep(s, '<th>비고</th></tr></thead><tbody><tr><td>2026.09.28 21:10</td>', '<th>비고</th></tr></thead><tbody><tr><td>2026.09.28 21:10</td>')
s = rep(s, '<b>실제 지급 켜짐 · 9/01 18:00부터.</b>', '<b>실제 지급 켜짐 · 2026.09.01 18:00부터.</b>')
s = rep(s, '전환 이력</div><table class="lt">', '전환 이력<span class="nt">켬 · 끔 전환은 사유 없이 일시 · 처리자만 남습니다</span></div><table class="lt">')
assert 'PG' not in re.sub(r'<title>.*?</title>', '', s) and '시즌 종료' not in s
wr('SA-034.dc.html', s)

# ── ③ PF-007-1 · PF-007-4
s = rd('PF-007-1.dc.html')
s = rep(s, '새 기능 · 혜택 소식 받기 <span class="c-alt">(선택)</span></span></span><a class="t-l2" href="#">보기</a></label>',
        '새 기능 · 혜택 소식 받기 <span class="c-alt">(선택)</span></span></span></label>', 2)
wr('PF-007-1.dc.html', s)
s = rd('PF-007-4.dc.html')
s = rep(s, '<span class="lbl req">사업자등록증</span>', '<span class="lbl">사업자등록증 <span class="c-alt">(선택)</span></span>', 2)
s = rep(s, '<span class="t-c1 c-alt">글자가 또렷하게 보이는 사진이면 돼요 · JPG · PNG · PDF</span>',
        '<span class="t-c1 c-alt">글자가 또렷하게 보이는 사진이면 돼요 · JPG · PNG · PDF · 지금 안 올리면 심사 때 요청할 수 있어요</span>', 2)
s = rep(s, '<span class="help">사업자등록증의 주소와 같아야 해요 · 검색이 안 되면 직접 입력해 주세요</span>',
        '<span class="help">사업자등록증의 주소와 같아야 해요 · 「주소 검색」은 무료 우편번호 서비스예요 · 검색 창이 열리지 않으면 우편번호 · 주소를 직접 적을 수 있어요</span>', 2)
addr_fail = ('<div class="st"><span class="st-tag">주소 검색을 열지 못함 · 직접 입력</span><div class="col" style="width: 100%; text-align: left; gap: 10px">'
             '<div class="msg msg-cau" style="width: 100%">주소 검색을 열지 못했어요. 우편번호와 주소를 직접 적어 주세요</div>'
             '<div class="fld"><label for="z6">사업장 주소</label><div class="row" style="gap: 8px"><input id="z6" class="inp num" type="text" value="" placeholder="우편번호" style="width: 120px"><button class="btn btn-out" type="button" disabled style="flex: none">주소 검색</button></div>'
             '<input class="inp" type="text" value="" placeholder="기본 주소" aria-label="기본 주소"><input class="inp" type="text" value="" placeholder="상세 주소" aria-label="상세 주소"><span class="help">우편번호 서비스 스크립트를 못 불러오면 우편번호 · 기본 주소 칸이 바로 입력칸으로 바뀌어요 · 다시 시도는 새로고침</span></div></div></div>')
s = rep(s, '<div class="st"><span class="st-tag">같은 사업자번호 중복</span>', addr_fail + '<div class="st"><span class="st-tag">같은 사업자번호 중복</span>')
wr('PF-007-4.dc.html', s)

# ── ④ MA-088 플랫폼 정보 (신규 · MA-086 셸 재사용)
base = rd('MA-086.dc.html')
head = base[:base.index('<main class="cont">')]
head = rep(head, '<title>발송 단가</title>', '<title>플랫폼 정보</title>')
head = rep(head, '<a class="on" href="MA-086.dc.html">발송 단가</a>', '<a class="" href="MA-086.dc.html">발송 단가</a>')
head = rep(head, '<a class="" href="MA-087.dc.html">외부 서비스 연동</a>', '<a class="" href="MA-087.dc.html">외부 서비스 연동</a><a class="on" href="MA-088.dc.html">플랫폼 정보</a>')
head = re.sub(r'<div class="wrap" style="min-height: \d+px">', '<div class="wrap" style="min-height: 1180px">', head)
fields = [('상호', 'c1', 'w-l', '', '사업자등록증의 상호 그대로'), ('대표자', 'c2', 'w-m', '', ''), ('사업자등록번호', 'c3', 'w-m', '숫자 10자리', '하이픈 없이'), ('통신판매업 신고번호', 'c4', 'w-l', '예: 제2026-서울강남-01234호', ''),
          ('사업장 주소', 'c5', 'w-xl', '', '우편번호 · 기본 주소 · 상세 주소를 한 줄로'), ('고객센터 전화', 'c6', 'w-m', '예: 1588-0000', '구매자 화면 바닥글과 메일에 표시'), ('고객센터 이메일', 'c7', 'w-l', 'example@email.com', '구매자 · 파트너스 문의 회신 주소')]
rows = ''.join(f'<tr><th>{k} <span class="rq">*</span></th><td><input id="{i}" class="i {w}" type="text" value="" placeholder="{p}">' + (f'<span class="hint">{h}</span>' if h else '') + '</td></tr>' for k, i, w, p, h in fields)
main = ('<main class="cont"><div class="pathbar">설정 › 플랫폼 정보</div><div class="ph2"><h1>플랫폼 정보</h1><span class="path">설정 › 플랫폼 정보</span><div class="acts"></div></div>'
        '<div class="note inf" style="width: 100%"><b>쇼핑몰 바닥글 · 주문서 · 메일에 플랫폼(호스팅 제공자)으로 표시되는 값입니다.</b> 수정은 최고관리자만 할 수 있고 변경은 로그 추적에 남습니다 · 한 항목이라도 비어 있으면 홈 「오늘 처리할 일」에 「플랫폼 정보 미입력」이 표시됩니다</div>'
        '<div class="sec-t">기본 정보<span class="nt">전자상거래법 표시 의무 항목 · 모두 필수</span></div><table class="ft"><colgroup><col style="width: 170px"><col></colgroup>' + rows + '</table>'
        '<div class="sec-t">변경 이력<span class="nt">저장할 때마다 항목별 이전 → 이후 값이 로그 추적에 남습니다</span><span class="acts"><a class="b sm" href="MA-070.dc.html">로그 추적</a></span></div>'
        '<table class="lt"><thead><tr><th style="width: 136px">일시</th><th style="width: 160px">항목</th><th>변경 (이전 → 이후)</th><th style="width: 140px">처리</th></tr></thead><tbody><tr><td colspan="4" class="l" style="color: var(--c24-sub)">아직 변경 기록이 없습니다</td></tr></tbody></table>'
        '<div class="savebar"><button class="b lg pri" type="button">저장</button><button class="b lg" type="button">취소</button></div>'
        '\n</main></div>\n<div class="states">\n<span class="states-h">상태 변형</span>\n')
def st(tag, body): return f'<div class="st"><span class="st-tag">{tag}</span>{COL}{body}</div></div>'
states = ''.join([
    st('저장 확인', '<div class="cfm"><div class="h">플랫폼 정보를 저장하시겠습니까?<button class="x" type="button" aria-label="닫기">×</button></div><div class="bd">바뀐 값은 저장 즉시 쇼핑몰 바닥글 · 주문서 · 메일에 반영됩니다. 변경은 로그 추적에 남습니다.</div><div class="f"><button class="b " type="button">취소</button><button class="b pri" type="button">저장</button></div></div>'),
    st('저장 완료', '<div class="toast2">플랫폼 정보를 저장했습니다<a href="MA-070.dc.html">로그 추적</a></div>'),
    st('입력 오류', '<input class="i err w-m" type="text" value="123-45-678" placeholder=""><span class="errt">사업자등록번호는 숫자 10자리로 입력해 주십시오</span><input class="i err w-l" type="text" value="help@onq" placeholder=""><span class="errt">이메일 형식을 확인해 주십시오</span><input class="i err w-m" type="text" value="" placeholder=""><span class="errt">고객센터 전화를 입력해 주십시오</span>'),
    st('읽기 전용 · 운영 · CS · 조회 전용 관리자', '<div class="note inf" style="width: 100%">플랫폼 정보는 최고관리자만 수정할 수 있습니다 · 값은 읽기 전용으로 보이고 「저장」 버튼은 보이지 않습니다</div><table class="ft" style="width: 100%"><colgroup><col style="width: 150px"><col></colgroup><tr><th>상호</th><td>[상호]</td></tr><tr><th>고객센터 전화</th><td>[고객센터 전화]</td></tr></table>'),
    st('미입력 · 홈 「오늘 처리할 일」 항목', '<div class="kpis" style="grid-template-columns: 1fr; width: 320px"><a class="kpi" href="MA-088.dc.html"><div class="k">플랫폼 정보 미입력</div><div class="v">3항목</div><div class="s">상호 · 사업자등록번호 · 고객센터 전화 비어 있음</div></a></div><span class="hint">한 항목이라도 비어 있으면 MA-001 「오늘 처리할 일」 줄에 이 타일이 보이고 누르면 이 화면으로 옵니다 · 모두 채우면 사라집니다 · 최고관리자가 아닌 관리자에게는 「최고관리자에게 요청」 안내로 보입니다</span>'),
    st('로딩', '<div class="box" style="width: 100%; padding: 14px"><div class="sk" style="height: 14px; width: 60%; margin-bottom: 8px"></div><div class="sk" style="height: 14px; width: 90%; margin-bottom: 8px"></div><div class="sk" style="height: 14px; width: 75%"></div></div>'),
    st('오류', '<div class="note neg" style="width: 100%"><b>불러오지 못했습니다.</b> 네트워크를 확인한 뒤 다시 시도해 주십시오.</div><button class="b " type="button">다시 시도</button>'),
])
tail = '\n</div>\n</div>\n</x-dc>\n<script type="text/x-dc" data-dc-script data-props=\'{"$preview":{"width":1920,"height":1900}}\'>\nclass Component extends DCLogic { renderVals() { return {}; } }\n</script>\n</body>\n</html>\n'
wr('MA-088.dc.html', head + main + states + tail)

# ── canvas.json: MA-088 등록(p03 · MA-086 옆 열), order 는 MA-087 뒤
c = json.loads(rd('canvas.json'))
assert 'MA-088.dc.html' not in c['boards']
c['boards']['MA-088.dc.html'] = {'h': 2000, 'is_interactive': True, 'page': 'p03', 'title': 'MA-088 플랫폼 정보 (최고관리자만 수정 · 표시 의무 7항목 · 변경 이력 · 미입력 → 홈 처리할 일)', 'w': 1920, 'x': 7200, 'y': 27008}
c['order'].insert(c['order'].index('MA-087.dc.html') + 1, 'MA-088.dc.html')
# 보드 높이(실제 렌더 + 20 을 10 단위 올림, 커질 때만)
import math
for k, h in {'MA-088.dc.html': 2074, 'SA-034.dc.html': 2195, 'PF-007-4.dc.html': 3847, 'SA-052.dc.html': 2122, 'SA-054.dc.html': 1740, 'MA-041.dc.html': 1381, 'MA-042.dc.html': 1760, 'SA-001-C.dc.html': 1189, 'PF-007-1.dc.html': 1609}.items():
    want = math.ceil((h + 20) / 10) * 10
    if c['boards'][k]['h'] < want: print('height', k, c['boards'][k]['h'], '->', want); c['boards'][k]['h'] = want
wr('canvas.json', json.dumps(c, ensure_ascii=False, indent=2) + '\n')
print('done')
