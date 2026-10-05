import re,json
P='/home/user/Live-OBS-Platform/design/project/'
BOARDS=['SA-027','SA-028','SA-014','SA-017','SA-015','SA-016','SA-046','SA-048','SA-047']
def iso2dot(s): return re.sub(r'\b(20\d\d)-(\d\d)-(\d\d)\b', r'\1.\2.\3', s)
def dt(s): return re.sub(r'\b(\d{1,2})/(\d{1,2}) (\d\d:\d\d)\b', lambda m: f'2026.{int(m.group(1)):02d}.{int(m.group(2)):02d} {m.group(3)}', s)
canvas=json.load(open(P+'canvas.json'))
for b in BOARDS:
    p=P+b+'.dc.html'; s=open(p).read(); o=s; rep=[]
    # 제목 · 쉬운 말
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
        vals=iter(['2026.09.06','2026.10.06']); ph=iter(['시작일','종료일'])
        s=re.sub(r'(class="i w-s dt" type="text" value=")[^"]*(" placeholder=")날짜 선택(")', lambda m: m.group(1)+next(vals,'2026.10.06')+m.group(2)+next(ph,'종료일')+m.group(3), s, count=2)
    # 일시 · 제목 앞 날짜 「10/2 」
    s2=dt(s); s2=iso2dot(s2); s2=re.sub(r'(<a [^>]*>)(\d{1,2})/(\d{1,2}) ', lambda m: f'{m.group(1)}2026.{int(m.group(2)):02d}.{int(m.group(3)):02d} ', s2)
    if s2!=s: rep.append('일시'); s=s2
    s2=re.sub(r'<th style="width: (\d+)px">일시</th>', lambda m: '<th style="width: 136px">일시</th>' if int(m.group(1))<136 else m.group(0), s); s2=s2.replace('<th>일시</th>','<th style="width: 136px">일시</th>')
    if s2!=s: rep.append('일시 폭'); s=s2
    # 확인 창 버튼 순서 [취소][실행]
    s2=re.sub(r'<div class="f"><button class="b pri( neg)?" type="button">([^<]*)</button><button class="b " type="button">취소</button></div>', r'<div class="f"><button class="b " type="button">취소</button><button class="b pri\1" type="button">\2</button></div>', s)
    s2=re.sub(r'<div class="f"><button class="b neg pri" type="button">([^<]*)</button><button class="b " type="button">(취소|유지)</button></div>', r'<div class="f"><button class="b " type="button">\2</button><button class="b neg pri" type="button">\1</button></div>', s2)
    if s2!=s: rep.append('cfm 순서'); s=s2
    if s!=o: open(p,'w').write(s)
    print(b, rep)
