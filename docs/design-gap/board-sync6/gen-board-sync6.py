#!/usr/bin/env python3
"""보드 반영 묶음 6 (디자인 전담 (6), MASTER 추가 배정 2026-10-06):
① SA-052 방송 화면 주소: 주소 「보기」 버튼 제거(서버는 토큰 해시만 저장 · 발급 때 1회만 노출) · 다시 보려면 「재발급」 안내
② SA-057 유튜브: 쉬운 말 구현(app/(seller)/seller/(shell)/youtube/page.tsx) 문구로 갱신. 구조(연결 섹션 · 「이렇게 씁니다」 단계표 · 현황 4칸 · 머리 동작 버튼)는 유지
③ SA-065 이벤트 팝업: 목록 「순서」 열(▲▼) · 수정 폼 「버튼 이름」 입력 추가(#864 유지 요소, 합니다체). SA-064 홈 배너 순서 「끌기(⋮⋮)」 → ▲▼ 로 통일
사용: gen-board-sync6.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리> [높이 json]"""
import sys, re, pathlib, json, math
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))
COL = '<div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start">'
def st(tag, body): return f'<div class="st"><span class="st-tag">{tag}</span>{COL}{body}</div></div>'

# ── ① SA-052 「보기」 제거
s = rd('SA-052.dc.html')
s = rep(s, '<button class="b sm" type="button">보기</button><button class="b sm pri" type="button">복사</button>', '<button class="b sm pri" type="button">복사</button>', 2)
s = rep(s, '<span class="hint">연결 키는 가려져 있습니다 · 「보기」로 열람하면 기록이 남습니다 · 발급 2026.08.02 ·',
        '<span class="hint">주소는 만들 때 한 번만 보입니다 · 다시 보려면 「재발급」으로 새 주소를 받습니다(기존 주소는 바로 쓸 수 없게 됩니다) · 발급 2026.08.02 ·')
assert '>보기<' not in s
wr('SA-052.dc.html', s)

# ── ② SA-057 쉬운 말 문구(구현 기준)
s = rd('SA-057.dc.html')
s = rep(s, '<title>유튜브 연결</title>', '<title>유튜브 이어 두기</title>')
s = rep(s, '<div class="pathbar">방송 › 외부 채널 연결 › 유튜브 연결</div><div class="ph2"><h1>유튜브 연결</h1><span class="path">방송 › 외부 채널 연결 › 유튜브 연결</span><div class="acts"><button class="b " type="button">연결 해제</button></div></div>',
        '<div class="pathbar">방송 › 외부 채널 연결 › 유튜브 이어 두기</div><div class="ph2"><h1>유튜브 이어 두기</h1><span class="path">방송 › 외부 채널 연결 › 유튜브 이어 두기</span><div class="acts"><button class="b " type="button">유튜브 이어 둔 것 풀기</button></div></div>')
main_old = s[s.index('<div class="sec-t">연결</div>'):s.index('</main>')]
main_new = ('<div class="sec-t">연결</div><table class="ft"><colgroup><col style="width: 170px"><col></colgroup>'
  '<tr><th>상태</th><td><span class="tag g">이어짐</span> <span class="nt">채널 [채널 이름] · 2026.10.02 14:02에 이어 둠</span></td></tr>'
  '<tr><th>채널 주소</th><td><a href="#">[채널 이름]</a> <button class="b sm" type="button">다른 채널로 바꾸기</button><span class="hint">채널을 바꾸면 지금 이어 둔 방송이 풀립니다 · 방송 중에는 바꿀 수 없습니다</span></td></tr>'
  '<tr><th>방송 주소</th><td><input class="i w-xl" type="text" value="" placeholder="방송 주소 (선택)"> <button class="b sm pri" type="button">방송 이어 두기</button> <button class="b sm" type="button">지금 하는 방송 찾아서 이어 두기</button><span class="hint">방송 주소를 비워 두고 채널만 이어 둬도 지금 하고 있는 공개 방송을 자동으로 찾아 줍니다</span></td></tr>'
  '<tr><th>유튜브 채팅 가져오기</th><td><label class="ck"><input type="checkbox" name="r">이 방송에서 채팅 가져오기 켜기</label><span class="hint">채팅 가져오기를 켜면 시청자의 채팅 표시 이름과 채팅 본문 앞 200자를 30일 동안 보관합니다. 주문 닉네임 확인에만 씁니다.</span></td></tr>'
  '<tr><th>채팅 가져오기 처음 설정</th><td><label class="ck"><input type="checkbox" name="r">새로 이어 두는 방송은 채팅 가져오기를 켠 채로 시작</label><span class="hint">처음에는 꺼져 있습니다. 이미 이어 둔 방송에는 영향이 없으며, 방송마다 켜고 끌 수 있습니다.</span></td></tr>'
  '</table><div class="note inf" style="width: 100%">공개 방송만 지원합니다. 비공개 · 일부 공개 방송의 채팅은 가져올 수 없습니다.</div>'
  '<div class="sec-t">이렇게 씁니다</div><table class="lt"><thead><tr><th class="num" style="width: 50px">순서</th><th>내용</th></tr></thead><tbody>'
  '<tr><td class="num">1</td><td class="l">내 유튜브 채널 주소를 넣고 「채널 이어 두기」를 누릅니다 · 채널이 맞는지 이름을 보여 드립니다</td></tr>'
  '<tr><td class="num">2</td><td class="l">방송 주소를 넣고 「방송 이어 두기」를 누르거나, 「지금 하는 방송 찾아서 이어 두기」로 진행 중인 공개 방송을 찾습니다</td></tr>'
  '<tr><td class="num">3</td><td class="l">방송이 이어지면(예정 · 진행 중) 이 화면이나 방송 대시보드에서 「채팅 가져오기」를 켭니다 · 처음에는 꺼져 있습니다</td></tr>'
  '<tr><td class="num">4</td><td class="l">주문대기에 「채팅 확인됨 · 마지막 채팅 시각」 또는 「채팅 없음」이 표시만 됩니다 · 순서 · 개봉에는 영향이 없습니다 · 비공개 · 일부 공개 방송은 모두 「채팅 없음」으로 보입니다</td></tr>'
  '</tbody></table>'
  '<div class="sec-t">채팅 가져오기 현황 (2026년 10월)<span class="acts"><button class="b sm" type="button">저장해 둔 채팅 지금 지우기</button></span></div>'
  '<div class="sum" style="grid-template-columns: repeat(4, 1fr)"><div><div class="k">이번 달 가져온 채팅</div><div class="v">8,420건</div></div><div><div class="k">저장해 둔 채팅</div><div class="v">3,120건<small>30일이 지나면 자동으로 지웁니다</small></div></div><div><div class="k">오늘 쓸 수 있는 무료 분량 중 사용</div><div class="v">42%<small>다 쓰면 내일까지 쉽니다</small></div></div><div><div class="k">이번 달 무료 분량 중 사용</div><div class="v">18%</div></div></div>'
  '<span class="hint">「저장해 둔 채팅 지금 지우기」는 대표자에게만 보입니다 · 저장해 둔 채팅이 없으면 비활성</span>\n')
s = s.replace(main_old, main_new)
states_old = s[s.index('<span class="states-h">상태 변형</span>') + len('<span class="states-h">상태 변형</span>'):s.index('\n</div>\n</div>\n</x-dc>')]
FT = '<table class="ft"><colgroup><col style="width: 170px"><col></colgroup>'
CFM = lambda h, bd, ok: f'<div class="cfm"><div class="h">{h}<button class="x" type="button" aria-label="닫기">×</button></div><div class="bd">{bd}</div><div class="f"><button class="b " type="button">취소</button><button class="b pri neg" type="button">{ok}</button></div></div>'
states_new = ''.join([
  st('이어지지 않음', FT + '<tr><th>상태</th><td><span class="tag n">이어지지 않음</span> <span class="nt">내 유튜브 채널 주소를 넣고 「채널 이어 두기」를 눌러 주십시오</span></td></tr><tr><th>채널 주소</th><td><input class="i w-l" type="text" value="" placeholder="예: @내채널이름 또는 유튜브 채널 주소"> <button class="b sm pri" type="button" disabled>채널 이어 두기</button></td></tr></table><span class="hint">머리의 「유튜브 이어 둔 것 풀기」 버튼은 채널을 이어 둔 뒤에만 보입니다</span>'),
  st('채널 바꾸기 · 입력 칸 열림', FT + '<tr><th>채널 주소</th><td><input class="i w-l" type="text" value="" placeholder="예: @내채널이름 또는 유튜브 채널 주소"> <button class="b sm pri" type="button">채널 바꾸기</button> <button class="b sm" type="button">취소</button></td></tr></table>'),
  st('서비스 준비 중 · 키 없음', '<div class="note cau" style="width: 100%"><b>유튜브 연결은 아직 준비 중입니다.</b> 준비가 끝나면 이 화면에서 바로 쓸 수 있습니다. 지금은 유튜브 연결과 채팅 가져오기를 쓸 수 없습니다.</div><span class="tag n">준비 중</span><span class="hint">입력 칸과 버튼은 모두 비활성</span>'),
  st('무료 분량 초과 · 잠시 멈춤 (오늘)', '<div class="note cau" style="width: 100%"><b>채팅 가져오기 잠시 멈춤</b> · 오늘 쓸 수 있는 무료 분량을 다 써서 채팅 가져오기가 멈췄습니다. 내일 자동으로 다시 시작합니다. 주문 처리와 방송 화면에는 영향이 없습니다.</div><span class="hint">현황 위에도 같은 안내가 보입니다 · 방송 중에는 대시보드 상단 띠에 「채팅 가져오기 잠시 멈춤」</span>'),
  st('무료 분량 초과 · 잠시 멈춤 (서비스 전체)', '<div class="note cau" style="width: 100%"><b>채팅 가져오기 잠시 멈춤</b> · 서비스 전체의 무료 분량이 다 차서 채팅 가져오기가 멈췄습니다. 분량이 풀리면 자동으로 다시 시작합니다. 주문 처리와 방송 화면에는 영향이 없습니다.</div>'),
  st('유튜브 응답 없음 · 잠시 멈춤', '<div class="note cau" style="width: 100%"><b>채팅 가져오기 잠시 멈춤</b> · 유튜브가 일시적으로 응답하지 않아 채팅 가져오기가 잠시 멈췄습니다. 1분 뒤 자동으로 다시 시도합니다.</div>'),
  st('주소 오류', '<input class="i w-l err" type="text" value="youtube.com/watch?v=…" placeholder=""><span class="errt">채널 주소가 아닙니다. @핸들 또는 유튜브 채널 주소를 넣어 주십시오. 방송 주소는 아래 칸에 넣습니다</span><span class="hint">오류 문구는 서버 응답을 그대로 보여 줍니다</span>'),
  st('이어 둔 방송 없음 · 채팅 켤 수 없음', FT + '<tr><th>유튜브 채팅 가져오기</th><td><span class="nt">이어 둔 방송이 있을 때 방송마다 켤 수 있습니다. 처음에는 꺼져 있습니다</span></td></tr></table>'),
  st('방송 이어짐 · 채팅 켬', FT + '<tr><th>방송 주소</th><td><a href="#">[방송 제목]</a> <span class="tag g">진행 중</span><br><button class="b sm" type="button">방송 이어 둔 것 풀기</button></td></tr><tr><th>유튜브 채팅 가져오기</th><td><label class="ck"><input type="checkbox" name="r" checked>이 방송에서 채팅 가져오기 켜기</label></td></tr></table><span class="hint">방송 상태 태그: 예정 · 진행 중 · 종료</span>'),
  st('채팅을 받을 수 없음 · 비공개 방송', '<div class="note cau" style="width: 100%"><b>채팅을 받을 수 없음</b> · 이 방송은 비공개 또는 회원 전용이라 채팅을 가져올 수 없습니다. 유튜브에서 공개로 바꾸면 다음 확인부터 표시됩니다.</div><span class="hint">채팅이 꺼진 방송: 「이 방송은 채팅을 쓸 수 없습니다. 유튜브에서 채팅이 꺼져 있거나 채팅을 지원하지 않는 방송입니다.」 · 채팅 종료: 「방송 중 채팅이 끝나서 더 이상 가져오지 않습니다.」</span>'),
  st('유튜브 이어 둔 것 풀기 확인', CFM('유튜브 이어 둔 것을 푸시겠습니까?', '새 방송을 자동으로 찾지 않습니다. 이미 시작된 방송은 그대로입니다.', '이어 둔 것 풀기')),
  st('방송 이어 둔 것 풀기 확인', CFM('방송 이어 둔 것을 푸시겠습니까?', '이 방송의 채팅 가져오기가 멈춥니다. 이미 시작된 방송은 그대로입니다.', '이어 둔 것 풀기')),
  st('채널 바꾸기 확인 · 이어 둔 방송 있음', CFM('채널을 바꾸면 지금 이어 둔 방송이 풀립니다. 바꾸시겠습니까?', '이어 둔 방송의 채팅 가져오기도 함께 멈춥니다. 방송 중에는 바꿀 수 없습니다.', '채널 바꾸기')),
  st('저장해 둔 채팅 지우기 확인', CFM('저장해 둔 채팅을 모두 지우시겠습니까?', '지운 채팅은 되돌릴 수 없습니다. 이번 달 가져온 채팅 건수는 줄지 않습니다.', '채팅 지우기')),
  st('완료 알림', '<div class="toast2">채널을 이어 뒀습니다</div><div class="toast2">방송을 찾아 이어 뒀습니다</div><div class="toast2">채팅 가져오기를 켰습니다</div><span class="hint">그 밖에: 채널을 바꿨습니다 · 방송을 이어 뒀습니다 · 채팅 가져오기를 껐습니다 · 유튜브 이어 둔 것을 풀었습니다 · 방송 이어 둔 것을 풀었습니다 · 저장해 둔 채팅을 지웠습니다 · 새 방송은 채팅 가져오기를 켠(끈) 채로 시작합니다</span>'),
  st('로딩', '<div class="box" style="width: 100%; padding: 14px"><div class="sk" style="height: 14px; width: 60%; margin-bottom: 8px"></div><div class="sk" style="height: 14px; width: 90%; margin-bottom: 8px"></div><div class="sk" style="height: 14px; width: 75%"></div></div>'),
  st('오류', '<div class="note neg" style="width: 100%"><b>유튜브 이어 둔 상태를 불러오지 못했습니다.</b> 네트워크를 확인한 뒤 다시 시도해 주십시오.</div><button class="b " type="button">다시 시도</button>'),
  st('이용권에 없는 기능', '<div class="note inf" style="width: 100%">지금 이용 중인 이용권에는 이 기능이 없습니다. 구독 화면에서 이용권을 바꾸면 사용할 수 있습니다</div>'),
  st('권한 없음 · 직원', '<div class="note inf" style="width: 100%">이 메뉴는 권한이 필요합니다. 대표자에게 요청해 주십시오 · 필요한 권한: 방송 진행</div>'),
])
s = s.replace(states_old, '\n' + states_new)
for bad in ['채팅 수집', '연결 해제', '연결됨', '연결 안 됨', '방송 화면는']: assert bad not in s, bad
wr('SA-057.dc.html', s)

# ── ③ SA-065 순서 열(▲▼) · 버튼 이름
def mv(i): return f'<div class="acts2" style="justify-content: center; align-items: center; gap: 6px"><b style="min-width: 14px">{i}</b><button class="b sm" type="button" aria-label="위로"{" disabled" if i == 1 else ""}>▲</button><button class="b sm" type="button" aria-label="아래로"{" disabled" if i == 4 else ""}>▼</button></div>'
s = rd('SA-065.dc.html')
s = rep(s, '<thead><tr><th>팝업</th><th style="width: 130px">형태</th>', '<thead><tr><th>팝업</th><th style="width: 150px">순서</th><th style="width: 130px">형태</th>')
main_end = s.index('<div class="states"')
head, rest = s[:main_end], s[main_end:]
n = [0]
def addord(m):
    n[0] += 1
    return m.group(0) + f'<td>{mv(n[0])}</td>'
head = re.sub(r'<tr><td><b>[^<]*</b></td>', addord, head)
assert n[0] == 4, n
s = head + rest
s = rep(s, '<td>페이지당 1개 · 목록 순서 우선</td>', '<td>페이지당 1개 · 목록 순서 우선 · 순서는 목록의 ▲▼로 바꿉니다</td>')
s = rep(s, '순서를 바꾸려면 목록에서 끌어 주십시오', '순서를 바꾸려면 목록의 ▲▼로 옮겨 주십시오')
s = rep(s, '<option>버튼 없음</option></select></td></tr>',
        '<option>버튼 없음</option></select></td></tr><tr><th>버튼 이름</th><td><input class="i w-m" type="text" value="방송 안내 보기" placeholder="자세히 보기" maxlength="20"><span class="hint">비우면 「자세히 보기」 · 20자 · 버튼이 「버튼 없음」이거나 상단 띠이면 보이지 않습니다</span></td></tr>')
wr('SA-065.dc.html', s)

# ── ③-2 SA-064 순서 끌기 → ▲▼
s = rd('SA-064.dc.html')
s = rep(s, '<th style="width: 60px">순서</th>', '<th style="width: 150px">순서</th>')
for i in range(1, 5):
    s = rep(s, f'<td><span class="nt">⋮⋮</span> {i}</td>', f'<td>{mv(i)}</td>')
s = rep(s, '<td>위에서부터 · 끌어서 변경</td>', '<td>위에서부터 · 목록의 ▲▼로 변경</td>')
s = rep(s, '<div class="st"><span class="st-tag">순서 바꾸는 중</span>' + COL + '<div class="box" style="width: 100%; padding: 8px 10px; border-color: var(--c24-acc); background: var(--c24-acc-bg)"><span class="nt">⋮⋮</span> 주말 브레이크 안내 <b style="float: right">2 → 1</b></div><span class="hint">놓으면 바로 저장 · 홈 슬라이드 순서가 즉시 바뀝니다</span>',
        '<div class="st"><span class="st-tag">순서 바꿈 · 저장 완료</span>' + COL + '<div class="box" style="width: 100%; padding: 8px 10px; border-color: var(--c24-acc); background: var(--c24-acc-bg)">▲ 주말 브레이크 안내 <b style="float: right">2 → 1</b></div><div class="toast2">순서를 저장했습니다 · 홈 슬라이드 순서가 바로 바뀝니다</div><span class="hint">▲▼를 누르면 바로 저장됩니다 · 맨 위 행의 ▲, 맨 아래 행의 ▼는 비활성</span>')
assert '⋮⋮' not in s
wr('SA-064.dc.html', s)

# ── canvas.json: SA-057 제목 · 높이(실제 렌더 + 20 → 10 단위 올림, 커질 때만)
c = json.loads(rd('canvas.json'))
c['boards']['SA-057.dc.html']['title'] = 'SA-057 유튜브 이어 두기 (쉬운 말 구현 문구 · 채널 · 방송 주소 · 채팅 가져오기 · 처음 설정 · 현황 4칸 · 30일 보관 고지 · 공개 방송만)'
for k, h in (json.loads(pathlib.Path(sys.argv[3]).read_text()).items() if len(sys.argv) > 3 else []):
    want = math.ceil((h + 20) / 10) * 10
    if c['boards'][k]['h'] < want: print('height', k, c['boards'][k]['h'], '->', want); c['boards'][k]['h'] = want
wr('canvas.json', json.dumps(c, ensure_ascii=False, indent=2) + '\n')
print('done')
