import re,json
P='/home/user/Live-OBS-Platform/design/project/'
BOARDS=['SA-063','SA-061','SA-082','SA-068','SA-031','SA-032','SA-033','SA-034','SA-080']
def iso2dot(s): return re.sub(r'\b(20\d\d)-(\d\d)-(\d\d)\b', r'\1.\2.\3', s)
def dt(s): return re.sub(r'\b(\d{1,2})/(\d{1,2}) (\d\d:\d\d)\b', lambda m: f'2026.{int(m.group(1)):02d}.{int(m.group(2)):02d} {m.group(3)}', s)
def cfm(title, body, act, neg=False):
    return ('<div class="cfm"><div class="h">'+title+'<button class="x" type="button" aria-label="닫기">×</button></div><div class="bd">'+body+'</div>'
            '<div class="f"><button class="b " type="button">취소</button><button class="b pri'+(' neg' if neg else '')+'" type="button">'+act+'</button></div></div>')
def st(tag, inner): return '<div class="st"><span class="st-tag">'+tag+'</span><div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start">'+inner+'</div></div>'
SAVE={
 'SA-063': cfm('주문 설정을 저장하시겠습니까?','바뀐 내용은 저장한 뒤 들어오는 주문부터 적용됩니다. 이미 접수된 주문은 그대로입니다.','저장'),
 'SA-061': cfm('배송 설정을 저장하시겠습니까?','바뀐 배송비 · 받는 방법은 저장한 뒤 들어오는 주문부터 적용됩니다. 이미 접수된 주문의 배송비는 바뀌지 않습니다.','저장'),
 'SA-068': cfm('회원 정책을 저장하시겠습니까?','재가입 제한 · 보관 기간은 저장 뒤 가입 · 탈퇴하는 회원부터 적용됩니다.','저장'),
 'SA-031': cfm('적립 정책을 저장하시겠습니까?','바뀐 적립률은 저장 뒤 결제되는 주문부터 적용됩니다. 이미 지급한 적립금은 그대로입니다.','저장'),
 'SA-080': cfm('알림 설정을 저장하시겠습니까?','바뀐 문구 · 발송 설정은 저장 뒤 보내는 알림부터 적용됩니다.','저장'),
 'SA-033': cfm('적립금 잔액을 조정하시겠습니까?','별빛사냥꾼 · <b>+5,000원</b> · 사유: 이벤트 보상 — 조정하면 바로 회원 잔액에 반영되고 원장에 남습니다.','조정'),
}
canvas=json.load(open(P+'canvas.json'))
for b in BOARDS:
    p=P+b+'.dc.html'; s=open(p).read(); o=s; rep=[]
    # 쉬운 말
    for a,c in [('실지급 스위치','실제 지급 켜기'),('적립금 실지급을 켜시겠습니까?','적립금을 실제로 지급하도록 켜시겠습니까?'),('실지급 켜기','실제 지급 켜기'),('실지급','실제 지급'),('시뮬레이션','계산만')]:
        if a in s: s=s.replace(a,c); rep.append(a)
    if b=='SA-080':
        s=s.replace('<h1>주문자 알림</h1>','<h1>알림 설정</h1>').replace('<div class="pathbar">설정 › 알림 설정 › 주문자 알림</div>','<div class="pathbar">설정 › 알림 설정</div>').replace('<span class="path">설정 › 알림 설정 › 주문자 알림</span>','<span class="path">설정 › 알림 설정</span>'); rep.append('h1')
    if b=='SA-031':
        s=s.replace('<td>9/15</td>','<td>2026.09.15</td>').replace('<td>8/02</td>','<td>2026.08.02</td>'); rep.append('이력 날짜')
    # 날짜 칸
    def fix_input(m):
        cls=m.group(1)
        if ' dt' in cls: return m.group(0)
        return f'class="{cls} dt" type="text" value="{iso2dot(m.group(2))}" placeholder="날짜 선택"'
    s2=re.sub(r'class="((?:i|inp)[^"]*)" type="text" value="(20\d\d-\d\d-\d\d)" placeholder=""', fix_input, s)
    if s2!=s: rep.append('date-input'); s=s2
    def fix_quick(m):
        g=m.group(0).replace('class="b sm dark"','class="b sm"').replace('class="b sm"','class="b"')
        return g.replace('>1개월<','>최근 1개월<').replace('<button class="b" type="button">최근 1개월</button>','<button class="b dark" type="button">최근 1개월</button>')
    s2=re.sub(r'(<button class="b sm(?: dark)?" type="button">(?:오늘|7일|1개월|3개월|전체)</button>\s*){3,}', fix_quick, s)
    if s2!=s:
        rep.append('quick'); s=s2
        vals=iter(['2026.09.06','2026.10.06']); s=re.sub(r'(class="i w-s dt" type="text" value=")[^"]*(" placeholder=")날짜 선택(")', lambda m: m.group(1)+next(vals,'2026.10.06')+m.group(2)+('시작일' if m.group(1) and True else '')+m.group(3), s, count=2)
        s=s.replace('placeholder="시작일"','placeholder="시작일"',1)
    s2=dt(s); s2=iso2dot(s2)
    if s2!=s: rep.append('일시'); s=s2
    # 확인 창 버튼 순서: [취소][실행]
    s2=re.sub(r'<div class="f"><button class="b pri( neg)?" type="button">([^<]*)</button><button class="b " type="button">취소</button></div>', r'<div class="f"><button class="b " type="button">취소</button><button class="b pri\1" type="button">\2</button></div>', s)
    if s2!=s: rep.append('cfm 순서'); s=s2
    # 저장 확인 창 상태
    if b in SAVE and '하시겠습니까?' not in s.split('<div class="states">')[-1].split('</div>')[0] and SAVE[b].split('<div class="h">')[1].split('<')[0] not in s:
        tag='조정 확인' if b=='SA-033' else '저장 확인'
        s=s.replace('<span class="states-h">상태 변형</span>','<span class="states-h">상태 변형</span>'+st(tag,SAVE[b]),1); rep.append('저장 확인')
        canvas['boards'][b+'.dc.html']['h']+=170
    if s!=o: open(p,'w').write(s)
    print(b, rep)
open(P+'canvas.json','w').write(json.dumps(canvas,indent=2,ensure_ascii=False)+'\n')
