import re,sys
A='/tmp/claude-0/-home-user-Live-OBS-Platform/bd26a41b-4b9f-5515-a664-7ebbd15ed355/scratchpad/art11/project/'
O='/tmp/claude-0/-home-user-Live-OBS-Platform/bd26a41b-4b9f-5515-a664-7ebbd15ed355/scratchpad/publish11/project/'
LOG=[]
def rep(s,b,pairs):
    for a,c,*n in pairs:
        cnt=s.count(a); exp=n[0] if n else None
        if cnt==0 and a in OPT: continue
        assert cnt>0,(b,a); 
        if exp is not None: assert cnt==exp,(b,a,cnt)
        s=s.replace(a,c); LOG.append(f'{b}: {a[:30]}×{cnt}')
    return s
def rm_state(s,b,tag):
    parts=s.split('<div class="st">'); i=[k for k,x in enumerate(parts) if x.startswith(f'<span class="st-tag">{tag}</span>')]
    assert len(i)==1,(b,tag); del parts[i[0]]; LOG.append(f'{b}: 변형 삭제 {tag}'); return '<div class="st">'.join(parts)
def hold_state(s,b,tag):
    a=f'<span class="st-tag">{tag}</span>'; assert s.count(a)==1,(b,tag)
    return s.replace(a,f'<span class="st-tag">보류 · {tag}</span><div class="note cau" style="width: 100%">가격 결정(대표님 몫) 전까지 보류한 변형입니다 · 구현하지 않습니다</div>')
def load(b): return open(A+b+'.dc.html').read()
def save(b,s): open(O+b+'.dc.html','w').write(s)
COMMON=[('플랫폼 운영팀','ONQ 운영팀'),('실지급','실제 지급')]
OPT={'플랫폼 운영팀','실지급','110,000원'}
# ---- SA-003 (SA-004 흡수, 구현 흐름)
s=load('SA-003')
s=rep(s,'SA-003',[
 ('<title>시작하기</title>','<title>시작하기 (쇼핑몰 여부 선택 포함)</title>'),
 ('첫 방송까지 네 단계입니다 · 순서대로 끝내면 홈으로 넘어갑니다 · 체험 중에는 구독 안내가 맨 위에 보입니다','가입 때 고른 갈래의 단계를 순서대로 끝내면 첫 방송을 할 수 있습니다 · 갈래는 아래에서 바꿀 수 있습니다 · 방송 화면만 쓰기는 체험 중 구독 안내가 맨 위에 보입니다'),
 ('<div class="sec-t">진행률 2 / 4<span class="nt">2단계 남았습니다</span></div><div style="height: 6px; background: #e6e9ee; border-radius: 3px; overflow: hidden; width: 100%"><i style="display: block; height: 100%; width: 50%; background: var(--c24-acc)"></i></div>',
  '<div class="sec-t">어떻게 쓰시겠습니까?<span class="nt">가입 신청 때 고른 갈래입니다 · 언제든 바꿀 수 있습니다</span></div><div class="two" style="grid-template-columns: 1fr 1fr"><div class="box" style="padding: 12px 16px; border-color: var(--c24-acc); background: var(--c24-acc-bg)"><label class="ck"><input type="radio" name="track" checked><b style="font-size: 14px">쇼핑몰까지 쓰기</b></label><div style="margin: 8px 0 0 24px; line-height: 20px">ONQ 쇼핑몰을 열고 상품 · 주문 · 배송까지 한곳에서 운영합니다.</div><div class="nt" style="margin: 4px 0 0 24px">쇼핑몰 통합 이용권 · 체험 없이 바로 시작 · 6단계</div></div><div class="box" style="padding: 12px 16px; border-color: var(--c24-line); background: #fff"><label class="ck"><input type="radio" name="track"><b style="font-size: 14px">방송 화면만 쓰기</b></label><div style="margin: 8px 0 0 24px; line-height: 20px">운영 중인 쇼핑몰은 그대로 두고 방송 주문대기와 방송 화면만 붙입니다.</div><div class="nt" style="margin: 4px 0 0 24px">오버레이 전용 이용권 · 7일 체험 · 3단계</div></div></div><div class="sec-t">진행률 2 / 6<span class="nt">4단계 남았습니다</span></div><div style="height: 6px; background: #e6e9ee; border-radius: 3px; overflow: hidden; width: 100%"><i style="display: block; height: 100%; width: 33%; background: var(--c24-acc)"></i></div>'),
 ('<tbody><tr><td class="c"><b style="font-size: 15px; color: #1b7f3b">✓</b></td><td><b>쇼핑몰 정보</b></td><td class="l">쇼핑몰 이름 · 대표 색 · 사업자 정보 · 고객센터를 적습니다.</td><td><span class="tag g">완료</span></td><td><a class="b sm" href="SA-060.dc.html">다시 보기</a></td></tr><tr><td class="c"><b style="font-size: 15px; ">3</b></td><td><b>첫 상품 등록</b></td><td class="l">상품 하나를 올리면 쇼핑몰이 열립니다.</td><td><span class="tag bl">다음</span></td><td><a class="b sm pri" href="SA-012.dc.html">바로 하기</a></td></tr><tr><td class="c"><b style="font-size: 15px; ">4</b></td><td><b>방송 화면 주소 복사</b></td><td class="l">OBS 브라우저 소스에 넣을 주소를 복사합니다. 테스트 방송으로 확인합니다.</td><td><span class="tag n">대기</span></td><td><a class="b sm" href="SA-052.dc.html">바로 하기</a></td></tr></tbody>',
  '<tbody><tr><td class="c"><b style="font-size: 15px; color: #1b7f3b">✓</b></td><td><b>이용권 결제</b></td><td class="l">이용권 요금을 결제하면 쇼핑몰과 방송 기능을 쓸 수 있습니다.</td><td><span class="tag g">완료</span></td><td><a class="b sm" href="SA-090.dc.html">다시 보기</a></td></tr><tr><td class="c"><b style="font-size: 15px; color: #1b7f3b">✓</b></td><td><b>쇼핑몰 정보 입력</b></td><td class="l">구매자에게 보이는 공유 문구를 입력합니다.</td><td><span class="tag g">완료</span></td><td><a class="b sm" href="SA-060.dc.html">다시 보기</a></td></tr><tr><td class="c"><b style="font-size: 15px; ">3</b></td><td><b>상품 등록</b></td><td class="l">판매할 상품을 한 개 이상 등록합니다.</td><td><span class="tag bl">지금 할 차례</span></td><td><a class="b sm pri" href="SA-012.dc.html">상품 등록으로</a></td></tr><tr><td class="c"><b style="font-size: 15px; ">4</b></td><td><b>주문 규칙</b></td><td class="l">입금해야 하는 시간과 자동 취소 같은 주문 규칙을 저장합니다.</td><td><span class="tag n">기다리는 중</span></td><td><a class="b sm" href="SA-063.dc.html">주문 설정으로</a></td></tr><tr><td class="c"><b style="font-size: 15px; ">5</b></td><td><b>방송 화면 꾸미기</b></td><td class="l">방송 화면에 보일 배치를 저장합니다.</td><td><span class="tag n">기다리는 중</span></td><td><a class="b sm" href="SA-051.dc.html">방송 화면 꾸미기로</a></td></tr><tr><td class="c"><b style="font-size: 15px; ">6</b></td><td><b>방송 화면 주소 복사</b></td><td class="l">방송 화면 꾸미기에서 주소를 만들어 복사한 뒤, 방송 프로그램(OBS)의 「브라우저 소스」 칸에 붙여 넣습니다.</td><td><span class="tag n">기다리는 중</span></td><td><a class="b sm" href="SA-052.dc.html">방송 화면 주소 복사</a></td></tr></tbody>'),
 ('<tr><th>구독</th><td>체험 중 · 10/9까지</td></tr>','<tr><th>이용권</th><td>쇼핑몰까지 쓰기 · 결제 완료</td></tr>'),
 ('단계마다 「바로 하기」로 들어가면 그 화면 위에 안내가 뜹니다 · 막히면 도우미에게 물어봐 주십시오','단계의 「…으로」 버튼으로 들어가면 그 화면 위에 안내가 뜹니다 · 막히면 도우미에게 물어봐 주십시오'),
 ('<div class="note cau" style="width: 100%"><b>체험 중 · 7일 남았습니다</b>','<div class="note cau" style="width: 100%; display: none"><b>체험 중 · 7일 남았습니다</b>'),
 ('<b>시작하기 2 / 4</b> · 쇼핑몰 정보를 적고 저장하면 다음 단계로 갑니다','<b>시작하기 3 / 6</b> · 상품을 하나 등록하면 다음 단계로 갑니다'),
 ('「바로 하기」로 들어온 화면 상단에 뜹니다 · 저장하면 자동 완료','단계 버튼으로 들어온 화면 상단에 뜹니다 · 저장하면 서버가 자동 완료로 계산합니다'),
])
# 방송 화면만 쓰기 변형 추가 + 닫기 토스트
extra='<div class="st"><span class="st-tag">방송 화면만 쓰기 · 3단계 (체험 중)</span><div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start"><div class="note cau" style="width: 100%"><b>체험 중 · 7일 남았습니다</b> · 오버레이 전용은 승인일부터 7일 체험입니다 (2026.10.09 (금)까지) · 끊기지 않으려면 그 전에 구독을 시작해 주십시오 <span style="float: right"><a class="b sm pri" href="SA-090.dc.html">구독 시작하기</a></span></div><div class="sec-t">진행률 1 / 3<span class="nt">2단계 남았습니다</span></div><table class="lt"><thead><tr><th style="width: 60px">단계</th><th style="width: 150px">할 일</th><th>내용</th><th style="width: 90px">상태</th><th style="width: 160px">관리</th></tr></thead><tbody><tr><td class="c"><b style="font-size: 15px; color: #1b7f3b">✓</b></td><td><b>다른 쇼핑몰 이어 쓰기</b></td><td class="l">운영 중인 쇼핑몰의 주소를 확인하고 이어 둡니다.</td><td><span class="tag g">완료</span></td><td><a class="b sm" href="SA-006.dc.html">다시 보기</a></td></tr><tr><td class="c"><b style="font-size: 15px; ">2</b></td><td><b>방송 화면 꾸미기</b></td><td class="l">방송 화면에 보일 배치를 저장합니다.</td><td><span class="tag bl">지금 할 차례</span></td><td><a class="b sm pri" href="SA-051.dc.html">방송 화면 꾸미기로</a></td></tr><tr><td class="c"><b style="font-size: 15px; ">3</b></td><td><b>방송 화면 주소 복사</b></td><td class="l">방송 화면 꾸미기에서 주소를 만들어 복사한 뒤, 방송 프로그램(OBS)의 「브라우저 소스」 칸에 붙여 넣습니다.</td><td><span class="tag n">기다리는 중</span></td><td><a class="b sm" href="SA-052.dc.html">방송 화면 주소 복사</a></td></tr></tbody></table></div></div><div class="st"><span class="st-tag">갈래 바꾸기 실패</span><div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start"><div class="note neg" style="width: 100%">안내를 바꾸지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오</div></div></div><div class="st"><span class="st-tag">나중에 하기 · 닫음</span><div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start"><div class="toast2">시작하기를 닫았습니다. 필요하면 다시 열 수 있습니다.<a href="#">다시 열기</a></div></div></div>'
s=rep(s,'SA-003',[('<span class="states-h">상태 변형</span>\n','<span class="states-h">상태 변형</span>\n'+extra)])
s=s.replace('"height":1300}','"height":1600}')
save('SA-003',s)
# ---- SA-004 → 흡수 안내만 남김
s=load('SA-004')
body_start=s.index('<main class="cont">'); body_end=s.index('</main>')
new_main='<main class="cont"><div class="pathbar">홈 › 홈 › 시작하기</div><div class="ph2"><a class="bk" href="SA-003.dc.html" title="뒤로" aria-label="뒤로"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4 6.5 10l6 6"/></svg></a><h1>시작하기 · 쇼핑몰 여부 (SA-003에 흡수)</h1><span class="path">홈 › 홈 › 시작하기</span><div class="acts"><a class="b pri" href="SA-003.dc.html">SA-003 시작하기 보기</a></div></div>\n<div class="note inf" style="width: 100%"><b>이 화면은 따로 없습니다.</b> 쇼핑몰 여부(「쇼핑몰까지 쓰기 / 방송 화면만 쓰기」)는 가입 신청 때 정해지고, 로그인 뒤에는 SA-003 시작하기 맨 위 선택 칸에서 바꿉니다(2026-10-06 MASTER 판정 · 구현 흐름 정본). 쇼핑몰 주소 확인 · 연동 인증은 SA-006 외부 쇼핑몰 연동, 대신 연결은 SA-150 자동 연결이 맡습니다.</div>\n'
s=s[:body_start]+new_main+s[body_end:]
ss=s.index('<div class="states">'); se=s.index('</x-dc>')
s=s[:ss]+'<div class="states">\n<span class="states-h">상태 변형</span>\n<div class="st"><span class="st-tag">흡수됨 → SA-003</span><div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start"><div class="note " style="width: 100%">갈래 선택 · 단계 목록 · 체험 배너 · 닫기 토스트는 SA-003에 있습니다</div></div></div>\n</div>\n</div>\n'+s[se:]
s=s.replace('<title>시작하기 · 쇼핑몰 여부</title>','<title>시작하기 · 쇼핑몰 여부 (SA-003에 흡수)</title>').replace('"height":1350}','"height":420}')
s=s.replace('min-height: 1002px','min-height: 240px')
save('SA-004',s)
# ---- SA-006 상태 3종
s=load('SA-006')
s=rep(s,'SA-006',[
 ('<span class="tag g">연결됨</span>','<span class="tag g">이어짐</span>'),
 ('<span class="tag y">다시 연결 필요</span>','<span class="tag y">다시 이어야 함</span>'),
 ('<span class="tag n">해제 대기</span>','<span class="tag n">끊는 중</span>'),
 ('<tr><td><b>별빛 아울렛</b><div class="nt">[쇼핑몰 주소]</div></td><td><span class="tag r">결제 잠금으로 멈춤</span></td><td>10/17부터 이벤트를 받지 않습니다</td><td><span style="white-space: nowrap">2026.07.03</span></td><td><a class="b sm pri" href="SA-090.dc.html">결제하고 다시 켜기</a></td></tr>','',1),
 ('<tr><td><span class="tag r">결제 잠금으로 멈춤</span></td><td class="l">구독 결제가 안 돼 멈췄습니다 · 결제하면 다시 켜집니다</td></tr>','',1),
 ('<th>마지막 이벤트</th>','<th>마지막으로 받은 주문 알림</th>'),
 ('2분 전 · 주문 생성','방금 전 · 주문 생성'),
 ('3일 전 · 권한이 만료됐습니다','허용이 풀려 주문 알림이 멈췄습니다'),
 ('오늘 11:20 · 쇼핑몰 응답을 기다리는 중','2026.10.06 11:20 · 쇼핑몰 응답을 기다리는 중'),
 ('다시 연결 필요: 쇼핑몰 관리자에서 앱 권한이 바뀌거나 만료되면 생깁니다 · 해제 대기: 쇼핑몰 응답이 늦어 연결을 끊는 중입니다 · 그동안 주문은 받지 않습니다','다시 이어야 함: 쇼핑몰 관리자에서 앱 권한이 바뀌거나 만료되면 생깁니다 · 끊는 중: 쇼핑몰 응답이 늦어 연결을 끊는 중입니다 · 그동안 주문은 받지 않습니다'),
 ('<td class="l">주문 이벤트를 받고 있습니다</td>','<td class="l">이어진 쇼핑몰의 주문이 들어오고 있습니다</td>'),
 ('<td class="l">권한이 끊겨 이벤트가 멈췄습니다 · 다시 연결하면 바로 이어집니다</td>','<td class="l">허용이 풀려 주문 알림이 멈췄습니다 · 다시 이으면 바로 이어집니다</td>'),
 ('<td class="l">연결을 끊고 있습니다 · 쇼핑몰 응답을 기다리는 중 · 주문은 받지 않습니다</td>','<td class="l">연결을 끊고 있습니다 · 쇼핑몰 응답을 기다리는 중 · 주문은 받지 않습니다 · 끝나면 「끊어짐」</td>'),
 ('<span class="st-tag">해제 대기 · 쇼핑몰 응답 대기</span>','<span class="st-tag">끊는 중 · 쇼핑몰 응답 대기</span>'),
 ('<span class="st-tag">해제 대기 → 해제됨</span>','<span class="st-tag">끊는 중 → 끊어짐</span>'),
 ('<button class="b sm" type="button">다시 시도</button></td></tr>','<button class="b sm" type="button">해제 다시 요청하기</button></td></tr>'),
 ('그동안 주문은 받지 않습니다</div><button class="b sm" type="button">다시 시도</button>','그동안 주문은 받지 않습니다</div><button class="b sm" type="button">해제 다시 요청하기</button>'),
 ('<button class="b sm pri" type="button">확인하기</button></td></tr></table><span class="hint">주소로 연결할 수 있는지','<button class="b sm pri" type="button">이 주소로 연결 시작하기</button></td></tr></table><span class="hint">주소로 연결할 수 있는지'),
 ('<th>쇼핑몰 주소 <span class="rq">*</span></th><td><input class="i w-l" type="text" value="" placeholder="운영 중인 쇼핑몰 주소">','<th>운영 중인 쇼핑몰 주소 <span class="rq">*</span></th><td><input class="i w-l" type="text" value="" placeholder="운영 중인 쇼핑몰 주소">'),
 ('연결 · 해제은 대표자나','연결 · 해제는 대표자나'),
 ('방송 주문대기와 방송 화면로 들어옵니다','방송 주문대기와 방송 화면으로 들어옵니다'),
])
s=rm_state(s,'SA-006','결제 잠금으로 멈춤')
s=s.replace('<span class="st-tag">끊는 중 · 쇼핑몰 응답 대기</span>','<span class="st-tag">끊는 중 · 쇼핑몰 응답 대기</span>',1)
s=s.replace('<span class="sec-t">','<span class="sec-t">')
s=rep(s,'SA-006',[('<div class="sec-t">변경 권한</div>','<div class="sec-t">변경 권한</div><div class="note inf" style="width: 100%; margin-bottom: 8px">「결제 잠금으로 멈춤」 상태는 서버에 생기면 추가합니다(2026-10-06 MASTER 판정)</div>')])
save('SA-006',s)
# ---- SA-111
s=load('SA-111')
s=rep(s,'SA-111',[('<th style="width: 110px">게시일</th>','<th style="width: 110px">올린 날</th>'),('오버레이 구매 랭킹','방송 화면 구매 랭킹'),('파트너스 명의 PG 연결 가이드 업데이트','결제 연결(ONQ 결제대행사) 안내 업데이트'),('<span class="nt">· 1–10 표시</span>','<span class="nt">20개씩 · 1–8 표시</span>'),('<span class="tag r">중요</span></td><td><span class="tag y">점검</span></td><td class="c"><span style="white-space: nowrap">2026-10-02</span>','<span class="tag r">중요</span> <span class="tag n">맨 위 고정</span></td><td><span class="tag y">점검</span></td><td class="c"><span style="white-space: nowrap">2026-10-02</span>')])
s=re.sub(r'2026-(\d\d)-(\d\d)',r'2026.\1.\2',s)
save('SA-111',s)
# ---- SA-112
s=load('SA-112')
s=rep(s,'SA-112',[('<div class="two" style="grid-template-columns: 1fr 1fr"><div><div class="sec-t">내 방송 일정과 겹칩니까?</div><div class="note pos" style="width: 100%">최근 방송 시작 시각 평균 20:00 · 점검 시간과 겹치지 않습니다</div></div><div><div class="sec-t">관련 공지</div>','<div><div class="sec-t">관련 공지</div>'),('파트너스 관리자 · 쇼핑몰 · 오버레이에 들어갈 수 없습니다','파트너스 관리자 · 쇼핑몰 · 방송 화면에 들어갈 수 없습니다'),('2026-10-02 10:00 게시','2026.10.02 10:00 올림'),('삭제됐거나 없는 공지입니다','삭제되었거나 볼 수 없는 공지입니다.')]+COMMON)
save('SA-112',s)
# ---- SA-113
s=load('SA-113')
s=rep(s,'SA-113',[('분류 <select','문의 종류 <select'),('<th style="width: 110px">분류</th>','<th style="width: 110px">문의 종류</th>'),('<th style="width: 150px">마지막 응답</th>','<th style="width: 150px">마지막 글</th>'),('<option>오버레이</option><option>PG · 결제</option>','<option>방송 화면</option><option>결제 연결</option>'),('방송 중 오버레이가 가끔 멈춥니다','방송 중 방송 화면이 가끔 멈춥니다'),('<td>오버레이</td>','<td>방송 화면</td>'),('<td>PG · 결제</td>','<td>결제 연결</td>'),('<span class="tag y">답변 완료</span></td></tr>','<span class="tag y">답변 완료</span> <span class="tag bl">새 답변</span></td></tr>'),('문의 내역이 없습니다','보낸 문의가 없습니다'),('PG 연결 · 오버레이 · 결제 문제는 문의하기로 남겨 주십시오','궁금한 점이나 오류는 「문의하기」로 보내 주십시오.')]+COMMON)
s=re.sub(r'2026-(\d\d)-(\d\d)',r'2026.\1.\2',s)
save('SA-113',s)
# ---- SA-114
s=load('SA-114')
s=rep(s,'SA-114',[('<th>분류 <span class="rq">*</span></th>','<th>문의 종류 <span class="rq">*</span></th>'),('>오버레이 · 방송<','>방송 화면<'),('>PG · 결제<','>결제 연결<'),('<b>오버레이가 멈출 때</b>','<b>방송 화면이 멈출 때</b>'),('<th>내용 <span class="rq">*</span></th>','<th>문의 내용 <span class="rq">*</span></th>'),('<th>첨부 (선택)</th>','<th>첨부 사진 (선택)</th>'),('>접수<','>문의 보내기<'),('오버레이 접속 기록','방송 화면 접속 기록'),('최근 PG 응답 코드 (PG · 결제 분류일 때)','최근 결제대행사 응답 코드 (결제 연결 종류일 때)'),('방송 중 결제 · 오버레이 장애는 「오버레이 · 방송」 분류','방송 중 결제 · 방송 화면 장애는 「방송 화면」 종류'),('10/2 방송 「','2026.10.02 방송 「'),('10/2 14:10 주문','2026.10.02 14:10 주문'),('실지급을 켰는데','실제 지급을 켰는데'),('플랫폼에 문의하기','ONQ 운영팀에 문의하기'),('문의를 접수했습니다','문의를 보냈습니다')])
s=rep(s,'SA-114',[('<span class="states-h">상태 변형</span>\n','<span class="states-h">상태 변형</span>\n<div class="st"><span class="st-tag">나가기 확인</span><div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start"><div class="cfm"><div class="h">작성 중인 내용이 사라집니다. 나가시겠습니까?<button class="x" type="button" aria-label="닫기">×</button></div><div class="bd">임시 저장을 누르면 내용을 남겨 두고 나갈 수 있습니다.</div><div class="f"><button class="b " type="button">취소</button><button class="b pri neg" type="button">나가기</button></div></div></div></div>')])
save('SA-114',s)
# ---- SA-115
s=load('SA-115')
s=rep(s,'SA-115',[('방송 중 오버레이가 가끔 멈춥니다','방송 중 방송 화면이 가끔 멈춥니다'),('오버레이 · 2026-10-02 14:35 접수','방송 화면 · 2026.10.02 14:35 보냄'),('관련: 10/2 방송','관련: 2026.10.02 방송'),(' · 10/2 14:35',' · 2026.10.02 14:35'),(' · 10/2 15:20',' · 2026.10.02 15:20'),('어제 방송(10/1) 21:03쯤 오버레이가','어제 방송(10/1) 21:03쯤 방송 화면이'),('<th>추가 문의</th>','<th>추가 문의 보내기</th>'),('>파일 첨부<','>사진 첨부<'),('종료 · 10/3','종료 · 2026.10.03'),('<td class="l">접수</td>','<td class="l">문의 보냄</td>'),('<span class="tag bl">접수</span>','<span class="tag bl">보냄</span>'),('<span class="st-tag">접수 (답변 대기)</span>','<span class="st-tag">보냄 (답변 대기)</span>'),('「운영팀이 확인 중입니다 · 평균 4시간」 안내','「ONQ 운영팀이 확인 중입니다 · 평균 4시간」 안내'),('입력창이 닫히고 「같은 내용으로 새 문의」 버튼이 보입니다','「종료된 문의입니다. 이어서 문의하시려면 새 문의로 보내 주십시오.」 안내와 「새 문의」 버튼이 보입니다')]+COMMON)
save('SA-115',s)
# ---- SA-150
s=load('SA-150')
s=rep(s,'SA-150',[('>확인하기<','>연결 가능한지 확인하기<'),('>직접 설정하기 (무료)<','>직접 설정하러 가기<'),('>고객이 준비할 것<','>직접 하셔야 하는 일<'),('110,000원 결제하고 시작','N원 결제하고 자동 설정 시작하기'),('1회 110,000원','1회 N원(마스터 관리자 설정값)'),('110,000원','N원'),('쇼핑몰과 OBS 방송 화면, 대신 연결해 드립니다','쇼핑몰과 방송 프로그램(OBS)을 대신 이어 드립니다'),('href="SA-004.dc.html"','href="SA-003.dc.html"'),('>직접 설정 시작<','>직접 설정하러 가기<')])
s=rep(s,'SA-150',[('<div class="sec-t">환불 · 재설치</div>','<div class="sec-t">환불 · 다시 설치<span class="nt">보류: 30일 무료 재설치 · 재설치 요금은 가격 결정(대표님 몫) 전까지 보류</span></div>')])
save('SA-150',s)
# ---- SA-151
s=load('SA-151')
s=rep(s,'SA-151',[('110,000원 결제하기','N원 결제하기'),('110,000원','N원'),('100,000원','N원'),('10,000원','N원'),('>이전<','>이전 화면으로<'),('>직접 설정 시작<','>직접 설정하러 가기<'),('오버레이에 표시되지 않고','방송 화면에 나오지 않고'),('완료 뒤 30일 동안 같은 쇼핑몰 · 같은 PC는 무료로 재설치해 드립니다. 그 밖의 재설치는 33,000원입니다.','완료 뒤 다시 설치 조건(무료 기간 · 요금)은 가격 결정 뒤 안내합니다 · 보류'),('<div class="sec-t">결제 금액</div>','<div class="sec-t">결제 금액<span class="nt">금액은 마스터 관리자 설정값(N원)</span></div>')])
save('SA-151',s)
# ---- SA-152
s=load('SA-152')
s=rep(s,'SA-152',[('>연결 취소하기<','>자동 설정 그만두기<'),('>직접 설정 시작<','>직접 설정하러 가기<'),('>직접 설정으로<','>직접 설정하러 가기<'),('110,000원을 전액 환불해 드립니다','결제한 금액(N원)을 전액 환불해 드립니다'),('취소하면 110,000원이 전액 환불됩니다','취소하면 결제한 금액(N원)이 전액 환불됩니다'),('110,000원','N원'),('3 OBS 오버레이 설치','3 방송 화면 넣기'),('OBS 오버레이에 「테스트 주문」이 보이는지','방송 화면에 「테스트 주문」이 보이는지'),('오버레이에 표시되지 않았습니다','방송 화면에 나오지 않았습니다'),('3단계(OBS 오버레이 설치)','3단계(방송 화면 넣기)'),('10/2 21:05 시작','2026.10.02 21:05 시작'),('10/2 21:20','2026.10.02 21:20'),('앱 설치 · 웹훅 · OBS 소스','앱 설치 · 웹훅 · 방송 화면 소스'),('OBS 소스 제거','방송 화면 소스 제거')])
save('SA-152',s)
# ---- SA-153
s=load('SA-153')
s=rep(s,'SA-153',[('테스트 주문이 OBS에 표시된 것까지','테스트 주문이 방송 화면에 나온 것까지'),('<th>OBS 오버레이</th>','<th>방송 화면</th>'),('오버레이 색 · 위치는 오버레이 편집기에서 바꿉니다','방송 화면의 색과 위치는 「방송 화면 꾸미기」에서 바꿉니다'),('>오버레이 편집기<','>방송 화면 꾸미기<'),('>오버레이 편집기에서 확인<','>방송 화면 꾸미기에서 확인<'),('>직접 설정으로<','>직접 설정하러 가기<'),('10/2 21:31 완료','2026.10.02 21:31 완료'),('10/3 09:10부터','2026.10.03 09:10부터'),('<th>무료 재설치</th>','<th>무료 재설치 (보류)</th>')])
s=hold_state(s,'SA-153','완료 뒤 연결 끊김 · 30일 안'); s=hold_state(s,'SA-153','재설치 결제 진입 · 30일 지남 · 환경 바뀜')
save('SA-153',s)
for l in LOG: print(l)
