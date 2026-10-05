import re,os,subprocess
P='/home/user/Live-OBS-Platform/design/project/'
FINAL=[l.strip() for l in subprocess.run(['git','show','origin/main:design/SCREEN_MAP.md'],capture_output=True,text=True,cwd='/home/user/Live-OBS-Platform').stdout.splitlines() if '| FINAL |' in l]
FINAL=sorted(set(l.split('|')[5].strip() for l in FINAL if l.count('|')>7 and l.split('|')[5].strip().endswith('.dc.html')))
SKIP={'SA-062.dc.html','SH-003-IA.dc.html','SH-005-IA.dc.html','SA-041.dc.html','SA-060.dc.html'}  # 열린 PR 몫
def iso2dot(s): return re.sub(r'\b(20\d\d)-(\d\d)-(\d\d)\b', r'\1.\2.\3', s)
def dt(s): return re.sub(r'\b(\d{1,2})/(\d{1,2}) (\d\d:\d\d)\b', lambda m: f'2026.{int(m.group(1)):02d}.{int(m.group(2)):02d} {m.group(3)}', s)
for f in FINAL:
    if f in SKIP or not os.path.exists(P+f): continue
    s=open(P+f).read(); o=s; rep=[]
    admin=f.startswith(('SA','MA','AU'))
    # 날짜 입력 칸 → .dt + 점 표기 + 자리글
    def fix_input(m):
        cls=m.group(1); val=m.group(2)
        if ' dt' in cls: return m.group(0)
        return f'class="{cls} dt" type="text" value="{iso2dot(val)}" placeholder="날짜 선택"'
    s2=re.sub(r'class="((?:i|inp)[^"]*)" type="text" value="(20\d\d-\d\d-\d\d)" placeholder=""', fix_input, s)
    if s2!=s: rep.append('date-input'); s=s2
    # 빠른 선택 묶음: 오늘 · 7일 · 1개월 · 3개월 · 전체 → 40 높이, 「최근 1개월」 기본
    def fix_quick(m):
        g=m.group(0)
        g=g.replace('class="b sm dark"','class="b sm"').replace('class="b sm"','class="b"')
        g=g.replace('>1개월<','>최근 1개월<').replace('<button class="b" type="button">최근 1개월</button>','<button class="b dark" type="button">최근 1개월</button>')
        return g
    s2=re.sub(r'(<button class="b sm(?: dark)?" type="button">(?:오늘|7일|1개월|3개월|전체)</button>\s*){3,}', fix_quick, s)
    if s2!=s:
        rep.append('quick'); s=s2
        # 기본 기간 값: 최근 1개월
        s=re.sub(r'value="2026\.01\.01"','value="2026.09.06"',s); s=re.sub(r'value="2026\.10\.0[1-5]"(\s*placeholder="날짜 선택")',r'value="2026.10.06"\1',s)
    s2=dt(s)
    if s2!=s: rep.append('datetime'); s=s2
    s2=iso2dot(s)
    if s2!=s: rep.append('isodate'); s=s2
    if s!=o: open(P+f,'w').write(s); print(f, rep)
