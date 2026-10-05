# PF-007-1~5 파트너스 가입 신청 단계 화면 생성 (2026-10-06 대표님 지시 · IA #722)
import os
OUT=['/home/user/Live-OBS-Platform/design/project/','/tmp/claude-0/-home-user-Live-OBS-Platform/bd26a41b-4b9f-5515-a664-7ebbd15ed355/scratchpad/publish15/project/']
STEPS=[('약관 동의','PF-007-1'),('본인확인','PF-007-2'),('가입 정보','PF-007-3'),('사업자 정보','PF-007-4'),('신청 완료','PF-007-5')]
ROUTES={'PF-007-1':'/seller/signup/terms','PF-007-2':'/seller/signup/verify','PF-007-3':'/seller/signup/account','PF-007-4':'/seller/signup/business','PF-007-5':'/seller/signup/done'}
HEADER_PC='''  <header class="row between" style="height: 72px; padding: 0 64px; box-shadow: inset 0 -1px 0 var(--wds-line-normal-alternative); background: var(--surface)">
    <div class="row" style="gap: 40px"><a class="logo" href="PF-001.dc.html" style="font-size: 20px"><span class="logo-sym"></span><span class="logo-word"></span></a><nav class="row" style="gap: 28px"><a class="t-l1 fw5 c-neu" href="PF-002.dc.html" style="color: inherit; text-decoration: none">기능</a><a class="t-l1 fw5 c-neu" href="PF-003.dc.html" style="color: inherit; text-decoration: none">요금</a><a class="t-l1 fw5 c-neu" href="PF-004.dc.html" style="color: inherit; text-decoration: none">자주 묻는 질문</a><a class="t-l1 fw5 c-neu" href="PF-005.dc.html" style="color: inherit; text-decoration: none">공지</a></nav></div>
    <div class="row" style="gap: 8px"><a class="btn btn-sm btn-out" href="AU-002.dc.html">로그인</a><a class="btn btn-sm" href="PF-007-1.dc.html">파트너스 가입 신청</a></div>
  </header>
'''
HEADER_M='''<header class="row between" style="height: 56px; padding: 0 16px; box-shadow: inset 0 -1px 0 var(--wds-line-normal-alternative)"><span class="logo" style="font-size: 17px"><span class="logo-sym"></span><span class="logo-word"></span></span><div class="row" style="gap: 6px"><a class="btn btn-sm btn-out" href="AU-002.dc.html">로그인</a><button class="icon-btn" type="button" aria-label="메뉴"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg></button></div></header>'''
def dot(n,state):  # state: done|cur|todo
    bg={'done':'var(--brand)','cur':'var(--brand)','todo':'var(--wds-fill-strong)'}[state]; fg={'done':'var(--brand-ink)','cur':'var(--brand-ink)','todo':'var(--wds-label-alternative)'}[state]
    inner='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"></path></svg>' if state=='done' else str(n)
    return f'<span style="width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800; background: {bg}; color: {fg}">{inner}</span>'
def stepper(cur, compact=False):
    parts=[]
    for i,(name,bid) in enumerate(STEPS,1):
        st='done' if i<cur else 'cur' if i==cur else 'todo'
        label=f'<span class="t-l1 {"fw7" if st=="cur" else "c-alt"}">{name}</span>' if not compact or st=='cur' else ''
        arrow='' if i==len(STEPS) else '<span class="arw" style="width: 16px"></span>'
        parts.append(f'<span class="row" style="gap: 6px; align-items: center">{dot(i,st)}{label}{arrow}</span>')
    return f'<div class="row" style="gap: 6px; align-items: center; flex-wrap: wrap"><span class="t-l2 fw7 c-pri num" style="margin-right: 4px">{cur} / 5</span>{"".join(parts)}</div>'
def nav(prev, nxt, nxt_label='다음', nxt_disabled=False, prev_label='이전 단계'):
    left=f'<a class="btn btn-lg btn-out" href="{prev}.dc.html">{prev_label}</a>' if prev else '<span></span>'
    right=(f'<button class="btn btn-lg" type="button" disabled>{nxt_label}</button>' if nxt_disabled else f'<a class="btn btn-lg" href="{nxt}.dc.html">{nxt_label}</a>')
    return f'<div class="row between" style="padding-top: 8px">{left}{right}</div>'
KEEP='<span class="t-c1 c-alt">입력한 내용은 새로고침하거나 뒤로 가도 남아 있어요(비밀번호는 빼고) · 이전 단계로 돌아가도 그대로예요</span>'
def fld(label,inp,help='',req=True,span=False,id=''):
    sp=' style="grid-column: 1 / -1"' if span else ''
    fo=' for="%s"'%id if id else ''
    rq=' class="req"' if req else ''
    hp='<span class="help">%s</span>'%help if help else ''
    return '<div class="fld"%s><label%s%s>%s</label>%s%s</div>'%(sp,fo,rq,label,inp,hp)
def inp(id,val='',ph='',typ='text',extra=''):
    cls='inp num' if typ=='num' else 'inp'; t='text' if typ=='num' else typ
    return '<input id="%s" class="%s" type="%s" value="%s" placeholder="%s"%s>'%(id,cls,t,val,ph,(' '+extra) if extra else '')
def st(tag, body): return f'<div class="st"><span class="st-tag">{tag}</span><div class="col" style="width: 100%; text-align: left; gap: 10px">{body}</div></div>'
def phone(cur, card_html, title):
    return f'<div class="st" style="grid-column: 1 / -1"><span class="st-tag">휴대폰 390</span><div class="app" data-theme="light" style="width: 390px; display: flex; flex-direction: column; background: var(--surface); box-shadow: 0 0 0 1px var(--wds-line-normal-alternative); text-align: left; margin: 0 auto">{HEADER_M}<section style="padding: 20px 16px 32px; background: var(--page)"><div class="col" style="gap: 8px"><h1 class="t-t2">파트너스 가입 신청</h1>{stepper(cur, compact=True)}<span class="t-l1 fw7" style="margin-top: 4px">{title}</span>{card_html.replace("grid-template-columns: 1fr 1fr","grid-template-columns: 1fr").replace("padding: 28px","padding: 18px 16px")}</div></section></div></div>'
def page(bid, cur, title, card_html, states, h, width=760):
    return f'''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>가입 신청 {cur}/5 · {title}</title>
<script src="./support.js"></script>
<link rel="stylesheet" href="ds/wds/tokens.css">
<link rel="stylesheet" href="lop.css">
</head>
<body>
<x-dc>
<helmet>
<style>body{{margin:0}}</style>
</helmet>
<div class="app" data-theme="light" style="width: 1440px; display: flex; flex-direction: column; background: var(--surface)">
{HEADER_PC}  <section style="padding: 56px 64px 80px; background: var(--page)"><div class="col" style="max-width: {width}px; margin: 0 auto; gap: 8px"><h1 class="t-t1">파트너스 가입 신청</h1><div style="margin-bottom: 20px">{stepper(cur)}</div><h2 class="t-t3" style="margin: 0 0 4px">{title}</h2>{card_html}</div><div class="states" style="padding: 24px 0 0; background: transparent; box-shadow: none; grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: 1312px; margin: 0 auto"><span class="states-h">상태 변형</span>{"".join(states)}{phone(cur, card_html, title)}</div></section>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":{h}}}}}'>
class Component extends DCLogic {{ renderVals() {{ return {{}}; }} }}
</script>
</body>
</html>
'''
FILES={}
# ---- 1 약관 동의
terms=lambda: ('<div class="card col" style="padding: 28px; gap: 14px">'
 '<label class="row" style="gap: 10px; padding-bottom: 14px; box-shadow: inset 0 -1px 0 var(--wds-line-normal-alternative)"><input class="cbx" type="checkbox" checked><span class="t-hl2">모두 동의해요</span></label>'
 '<label class="row between" style="gap: 10px"><span class="row" style="gap: 10px"><input class="cbx" type="checkbox" checked><span class="t-l1">이용약관 <span class="c-neg">(필수)</span></span></span><a class="t-l2" href="PF-008.dc.html">보기</a></label>'
 '<label class="row between" style="gap: 10px"><span class="row" style="gap: 10px"><input class="cbx" type="checkbox" checked><span class="t-l1">개인정보 수집 · 이용 <span class="c-neg">(필수)</span></span></span><a class="t-l2" href="PF-009.dc.html">보기</a></label>'
 '<label class="row between" style="gap: 10px"><span class="row" style="gap: 10px"><input class="cbx" type="checkbox" checked><span class="t-l1">파트너스 운영 정책 (구매자 개인정보 보호 · 방송 표시 규칙) <span class="c-neg">(필수)</span></span></span><a class="t-l2" href="PF-008.dc.html">보기</a></label>'
 '<label class="row between" style="gap: 10px"><span class="row" style="gap: 10px"><input class="cbx" type="checkbox" checked><span class="t-l1">새 기능 · 혜택 소식 받기 <span class="c-alt">(선택)</span></span></span><a class="t-l2" href="#">보기</a></label>'
 '<span class="t-c1 c-alt">만 19세 이상 사업자만 신청할 수 있어요 · 다음 단계는 대표자 휴대폰 본인확인이에요</span>'
 + nav('PF-001','PF-007-2',prev_label='취소') + '</div>')
FILES['PF-007-1']=page('PF-007-1',1,'약관 동의',terms(),[
 st('필수 약관 미동의', '<div class="msg msg-neg" style="width: 100%">필수 약관에 동의해 주세요</div><button class="btn btn-lg" type="button" disabled>다음</button>'),
 st('약관이 바뀜 (돌아왔을 때)', '<div class="msg msg-cau" style="width: 100%">약관이 바뀌었어요. 다시 확인해 주세요</div><span class="t-c1 c-alt">동의한 약관 버전을 서버가 함께 저장해요 · 버전이 다르면 이 단계로 돌려보내요</span>'),
],1500,width=640)
# ---- 2 본인확인
verify_form=('<div class="card col" style="padding: 28px; gap: 14px"><span class="t-c1 c-alt">본인 명의의 휴대폰으로 인증해 주세요 · 본인확인은 사업자 확인 · 승인과 별개예요 · 한 대표자는 쇼핑몰 하나만 열 수 있어요</span>'
 '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px">'
 + fld('이름',inp('vn','','이름'),id='vn') + fld('생년월일',inp('vb','','예: 19900101',typ='num'),id='vb')
 + '<div class="fld"><label>성별</label><div class="seg" style="align-self: flex-start"><button class="on" type="button">남</button><button class="" type="button">여</button></div></div>'
 + '<div class="fld"><label>내 · 외국인</label><div class="seg" style="align-self: flex-start"><button class="on" type="button">내국인</button><button class="" type="button">외국인</button></div></div>'
 + fld('통신사','<select id="vc" class="inp"><option>골라 주세요</option><option>SKT</option><option>KT</option><option>LG U+</option><option>알뜰폰 (SKT망)</option><option>알뜰폰 (KT망)</option><option>알뜰폰 (LG U+망)</option></select>',id='vc')
 + fld('휴대폰번호',inp('vh','','숫자만 입력',typ='num'),id='vh')
 + '</div><label class="row" style="gap: 8px"><input class="cbx" type="checkbox"><span class="t-c1">본인확인 이용 약관에 모두 동의해요</span><a class="t-c1" href="SH-030.dc.html" style="margin-left: auto">보기</a></label>'
 '<button class="btn btn-block" type="button" style="justify-content: center">인증번호 문자 받기</button>'
 + KEEP + nav('PF-007-1','PF-007-3',nxt_disabled=True) + '</div>')
done_box='<div class="row" style="gap: 10px; padding: 12px 14px; border-radius: 10px; background: var(--wds-background-status-positive); width: 100%"><span class="st-ic" style="width: 24px; height: 24px; background: var(--pos-text); color: #fff; font-size: 12px; flex: none"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"></path></svg></span><span class="col" style="gap: 1px; flex: 1; min-width: 0"><span class="t-l1 fw6">본인확인을 마쳤어요</span><span class="t-c1 c-alt num">김별빛 · [휴대폰 번호] · 방금</span></span><button class="btn btn-sm btn-text" type="button" style="flex: none">다시 확인</button></div>'
FILES['PF-007-2']=page('PF-007-2',2,'대표자 휴대폰 본인확인',verify_form,[
 st('인증번호 입력', '<div class="msg msg-info" style="width: 100%">인증번호를 보냈어요. 문자로 받은 6자리를 넣어 주세요</div><div class="fld"><label for="code" class="req">인증번호</label><div class="row" style="gap: 6px"><input id="code" class="inp num" type="text" value="" placeholder="6자리" style="flex: 1"><button class="btn" type="button">인증번호 확인하기</button></div><span class="help">02:41 · 3번까지 넣을 수 있어요 · <a href="#">인증번호 다시 받기</a></span></div>'),
 st('본인확인 완료 → 다음 활성', done_box + nav('PF-007-1','PF-007-3')),
 st('실패 · 번호 틀림', '<div class="col" style="gap: 8px; padding: 12px 14px; border-radius: 10px; background: var(--wds-background-status-negative); width: 100%"><span class="t-l1 fw6" style="color: var(--neg-text)">인증번호가 맞지 않아요</span><span class="t-c1 c-neu">문자로 받은 6자리를 다시 확인해 주세요. 2번 더 넣을 수 있어요.</span><button class="btn btn-sm" type="button" style="align-self: flex-start">정보 다시 쓰기</button></div>'),
 st('입력 오류', '<div class="fld"><label for="e1">생년월일</label><input id="e1" class="inp is-error num" type="text" value="199001"><span class="err">생년월일 8자리를 다시 확인해 주세요</span></div>'),
 st('오늘 한도 초과', '<div class="msg msg-cau" style="width: 100%">오늘은 본인확인을 더 할 수 없어요. 내일 다시 해 주세요</div>'),
 st('테스트 서버만 · 본인확인 안내줄', '<div class="msg msg-cau t-c1" style="width: 100%">테스트 모드예요. 인증번호 000000을 넣어 주세요</div>'),
 st('이미 신청한 대표자', '<div class="col" style="gap: 8px; padding: 14px; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--wds-line-normal-normal); width: 100%"><span class="t-l1 fw6">이미 가입한 계정이 있어요</span><span class="t-c1 c-alt">이 대표자 명의로 신청한 파트너스 계정이 있어요. 로그인하거나 이메일(아이디)을 찾아 주세요.</span><div class="row" style="gap: 6px; flex-wrap: wrap"><a class="btn btn-sm" href="AU-002.dc.html">로그인하기</a><a class="btn btn-sm btn-out" href="AU-003.dc.html">이메일(아이디) 찾기</a></div></div>'),
 st('이미 운영 중인 쇼핑몰 (신청 차단)', '<div class="msg msg-cau" style="width: 100%"><span><b>이미 운영 중인 쇼핑몰이 있어요.</b> 한 대표자는 쇼핑몰 하나만 열 수 있어요.</span></div><span class="t-c1 c-alt">본인확인 결과로 바로 확인해요 · 다른 쇼핑몰 이름은 보여 주지 않아요 · 여기서 막히고 다음 단계로 가지 않아요</span><div class="row" style="gap: 8px"><a class="btn btn-sm" href="AU-002.dc.html">로그인하기</a><a class="btn btn-sm btn-out" href="PF-008.dc.html">문의하기</a></div>'),
 st('앞 단계 없이 주소로 바로 들어옴', '<div class="msg msg-info" style="width: 100%">앞 단계부터 진행해 주세요. 약관 동의로 돌아가요</div><span class="t-c1 c-alt">어느 단계 주소로 들어와도 첫 미완료 단계로 보내요 · 끝낸 단계의 입력값은 그대로예요</span>'),
],2300)
# ---- 3 가입 정보
track_cards=('<div class="col" style="gap: 8px"><span class="t-hl2">지금 운영 중인 쇼핑몰이 있나요?</span><div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px">'
 '<label class="col" style="gap: 6px; padding: 14px; border-radius: 12px; box-shadow: inset 0 0 0 2px var(--brand); background: var(--wds-background-status-positive)"><span class="row" style="gap: 8px"><input class="rdo" type="radio" name="t" checked><span class="t-l1 fw7">있어요 · 방송 화면만 쓸게요</span></span><span class="t-c1 c-neu">지금 쇼핑몰은 그대로 두고 방송 주문대기와 방송 화면만 붙여요</span><span class="t-c1 c-alt">오버레이 전용 · 7일 체험 · 사업자 정보 없이 바로 신청</span></label>'
 '<label class="col" style="gap: 6px; padding: 14px; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--wds-line-normal-normal)"><span class="row" style="gap: 8px"><input class="rdo" type="radio" name="t"><span class="t-l1 fw7">없어요 · 쇼핑몰까지 쓸게요</span></span><span class="t-c1 c-neu">ONQ 쇼핑몰을 열고 상품 · 주문 · 배송까지 한곳에서 운영해요</span><span class="t-c1 c-alt">쇼핑몰 통합 · 다음 단계에서 사업자 정보를 받아요</span></label>'
 '</div><span class="t-c1 c-alt">나중에 로그인한 뒤 「시작하기」에서 바꿀 수 있어요</span></div>')
account_form=('<div class="card col" style="padding: 28px; gap: 20px"><div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px">'
 + fld('이메일 (로그인에 써요)',inp('c1','byulbit@mail.com','',typ='email'),id='c1') + fld('비밀번호',inp('c2','••••••••••','',typ='password'),'8자 이상',id='c2')
 + fld('쇼핑몰 이름',inp('c3','카드숍 별빛',''),'나중에 바꿀 수 있어요',id='c3') + fld('쇼핑몰 주소',inp('c6','byulbit','예: byulbit'),'영문 소문자 · 숫자 · 하이픈(-)으로 3~30자 · 구매자가 쇼핑몰 주소창에 쓰는 이름이에요',id='c6')
 + fld('주로 파는 것','<select id="c4" class="inp"><option>트레이딩카드</option><option>피규어 · 굿즈</option><option>의류 · 잡화</option><option>식품</option><option>기타</option></select>',id='c4')
 + fld('방송 채널 주소 (선택)',inp('c5','','유튜브 · 치지직 등 채널 주소'),'심사에 참고해요. 없어도 신청할 수 있어요.',req=False,id='c5')
 + '</div>' + track_cards + KEEP + nav('PF-007-2','PF-007-4') + '</div>')
FILES['PF-007-3']=page('PF-007-3',3,'가입 정보',account_form,[
 st('입력 오류', '<div class="fld"><label for="x1">이메일</label><input id="x1" class="inp is-error" type="text" value="byulbit@mail.com"><span class="err">이미 가입된 이메일이에요. 로그인하거나 비밀번호를 찾아 주세요</span></div><div class="fld"><label for="x2">쇼핑몰 주소</label><input id="x2" class="inp is-error" type="text" value="Byul bit"><span class="err">영문 소문자 · 숫자 · 하이픈(-)으로 3~30자를 써 주세요</span></div><div class="fld"><label for="x3">쇼핑몰 주소</label><input id="x3" class="inp is-error" type="text" value="admin"><span class="err">쓸 수 없는 주소예요. 다른 주소를 정해 주세요</span></div><div class="msg msg-neg" style="width: 100%">빨간 글씨가 있는 칸을 다시 확인해 주세요</div>'),
 st('쇼핑몰 주소 확인', '<div class="fld"><label for="x4">쇼핑몰 주소</label><input id="x4" class="inp" type="text" value="byulbit"><span class="help" style="color: var(--pos-text)">쓸 수 있는 주소예요 · onq.kr/byulbit</span></div><div class="fld"><label for="x5">쇼핑몰 주소</label><input id="x5" class="inp is-error" type="text" value="starlight"><span class="err">이미 쓰고 있는 주소예요. 다른 주소를 정해 주세요</span></div>'),
 st('있어요(방송 화면만) 선택 → 다음이 「신청하기」', '<span class="t-c1 c-alt">사업자 정보 단계를 건너뛰고 바로 신청해요 · 진행 표시는 4단계가 「건너뜀」으로 보여요</span>' + nav('PF-007-2','PF-007-5',nxt_label='신청하기')),
 st('신청하는 중', '<button class="btn btn-lg" type="button" disabled>신청하고 있어요</button>'),
],2500)
# ---- 4 사업자 정보
biz_form=('<div class="card col" style="padding: 28px; gap: 20px"><span class="t-c1 c-alt">사업자등록증을 보고 적어 주세요 · 적은 정보는 국세청 · 통신판매업 신고 내역과 자동으로 맞춰 봐요</span><div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px">'
 + fld('상호',inp('b1','별빛상사',''),id='b1')
 + '<div class="fld"><label for="b3" class="req">사업자등록번호</label><div class="row" style="gap: 6px"><input id="b3" class="inp num" type="text" value="[사업자등록번호]" placeholder="숫자 10자리" style="flex: 1"><button class="btn btn-out" type="button">조회</button></div><span class="help" style="color: var(--pos-text)">계속사업자 · 2019년 개업</span></div>'
 + fld('개업일',inp('b7','','예: 20200101',typ='num'),'사업자등록증에 적힌 날짜예요',id='b7')
 + fld('통신판매업 신고번호',inp('b4','','예: 제2024-서울강남-01234호'),'없으면 신고 후 신청해 주세요',id='b4')
 + fld('연락처',inp('b5','010-0000-0000',''),id='b5')
 + '<div class="fld" style="grid-column: 1 / -1"><label for="b6" class="req">사업장 주소</label><div class="row" style="gap: 8px"><input id="b6" class="inp num" type="text" value="03925" readonly style="width: 120px; background: var(--wds-fill-alternative)" aria-label="우편번호"><button class="btn btn-out" type="button" style="flex: none">주소 검색</button></div><input class="inp" type="text" value="[사업장 주소]" readonly style="background: var(--wds-fill-alternative)" aria-label="기본 주소"><input class="inp" type="text" value="3층" placeholder="상세 주소" aria-label="상세 주소"><span class="help">사업자등록증의 주소와 같아야 해요 · 검색이 안 되면 직접 입력해 주세요</span></div>'
 + '</div><div class="col" style="gap: 6px"><span class="lbl req">사업자등록증</span><div class="row" style="gap: 12px; align-items: center; padding: 14px; border-radius: 10px; border: 2px dashed var(--wds-line-normal-normal)"><span class="img" style="width: 56px; height: 72px">사진</span><span class="col" style="gap: 2px; flex: 1"><span class="t-l1 fw6">사업자등록증.jpg · 1.2MB</span><span class="t-c1 c-alt">글자가 또렷하게 보이는 사진이면 돼요 · JPG · PNG · PDF</span></span><button class="btn btn-sm btn-out" type="button">바꾸기</button></div></div>'
 + KEEP + nav('PF-007-3','PF-007-5',nxt_label='신청하기') + '</div>')
FILES['PF-007-4']=page('PF-007-4',4,'사업자 정보',biz_form,[
 st('입력 오류', '<div class="fld"><label for="y1">사업자등록번호</label><input id="y1" class="inp is-error num" type="text" value="123-45-6789"><span class="err">사업자등록번호를 다시 확인해 주세요</span></div><div class="fld"><label for="y2">개업일</label><input id="y2" class="inp is-error num" type="text" value="2020011"><span class="err">개업일 8자리를 다시 확인해 주세요</span></div><div class="fld"><label for="y3">통신판매업 신고번호</label><input id="y3" class="inp is-error" type="text" value=""><span class="err">통신판매업 신고번호를 적어 주세요</span></div>'),
 st('조회 결과 · 휴업 · 기록 불일치', '<div class="msg msg-cau" style="width: 100%; flex-direction: column; align-items: flex-start; gap: 4px"><b>국세청에 영업 중인 사업자로 나오지 않아요</b><span>영업 중인 사업자만 신청할 수 있어요. 잘못 나온 것 같으면 문의해 주세요.</span></div><div class="msg msg-neg" style="width: 100%">입력한 사업자 정보가 국세청 기록과 달라요. 사업자등록증을 보고 다시 확인해 주세요</div><div class="msg msg-cau" style="width: 100%">국세청 조회가 아직 안 끝났어요. 잠시 뒤 확인해요</div>'),
 st('통신판매업 조회', '<div class="msg msg-neg" style="width: 100%">통신판매업 신고 내역을 찾지 못했어요</div><div class="msg msg-cau" style="width: 100%">통신판매업이 정상 영업 상태가 아니에요</div><div class="msg msg-info" style="width: 100%">통신판매업 신고 조회를 아직 하지 못했어요 · 신청은 받고 확인이 끝나면 알려 드려요</div>'),
 st('같은 사업자번호 중복', '<div class="msg msg-cau" style="width: 100%"><span><b>같은 사업자번호로 운영하거나 신청 중인 쇼핑몰이 있어요.</b> 한 사업자는 쇼핑몰 하나만 열 수 있어요.</span></div><div class="row" style="gap: 8px"><a class="btn btn-sm" href="AU-002.dc.html">로그인하기</a><a class="btn btn-sm btn-out" href="PF-008.dc.html">문의하기</a></div>'),
 st('신청하는 중', '<button class="btn btn-lg" type="button" disabled>신청하고 있어요</button><div class="msg msg-neg" style="width: 100%; margin-top: 8px">신청하지 못했어요. 잠시 뒤 다시 시도해 주세요</div>'),
 st('방송 화면만 쓰기 (있어요) · 이 단계 없음', '<div class="msg msg-info" style="width: 100%"><b>오버레이 전용은 사업자 정보가 필요 없어요.</b> 3단계에서 바로 신청하고, 사업자 · 정산 정보는 쇼핑몰 통합으로 바꿀 때 받아요.</div><div class="row between" style="padding: 10px 12px; border-radius: 10px; background: var(--wds-fill-alternative); width: 100%"><span class="t-l2 c-alt">사업자 정보</span><span class="bdg b-gray">건너뜀</span></div>'),
],2500)
# ---- 5 완료
done_card=('<div class="card col" style="padding: 36px 28px; gap: 18px; align-items: center; text-align: center"><div class="st-ic" style="width: 64px; height: 64px; color: var(--pos-text); background: var(--wds-background-status-positive)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"></path></svg></div><h2 class="t-t2">신청을 받았어요</h2><p class="t-b1 c-neu" style="line-height: 1.7">대표자 본인 확인과 사업자 정보를 바로 확인해요 · 보통 몇 분 안에 결과를 알려 드려요.<br>확인이 필요하면 2영업일 안에 알려 드려요.<br>승인되면 [이메일]과 알림톡으로 파트너스 관리자 주소를 보내 드려요.<br>보완이 필요하면 메일로 먼저 연락드릴게요.</p>'
 '<div class="card col" style="padding: 18px; gap: 8px; width: 100%; background: var(--page); box-shadow: none; text-align: left"><span class="t-hl2">승인되면 이렇게 시작해요</span><span class="row t-l1" style="gap: 8px"><span class="num fw7 c-pri">1</span><span class="c-neu">메일로 받은 관리자 주소에서 가입 때 정한 비밀번호로 로그인해요</span></span><span class="row t-l1" style="gap: 8px"><span class="num fw7 c-pri">2</span><span class="c-neu">「시작하기」 단계를 따라 준비해요 · 방송 화면만 쓰기는 승인일부터 7일이 체험 기간이에요</span></span><span class="row t-l1" style="gap: 8px"><span class="num fw7 c-pri">3</span><span class="c-neu">이용권 결제 → 쇼핑몰 정보 → 상품 등록 → 주문 규칙 → 방송 화면 꾸미기 → 방송 화면 주소 복사 순서예요</span></span></div>'
 '<div class="row" style="gap: 8px"><a class="btn btn-lg" href="AU-005.dc.html">신청 상태 보기</a><a class="btn btn-lg btn-out" href="PF-002.dc.html">기능 미리 보기</a></div></div>')
FILES['PF-007-5']=page('PF-007-5',5,'신청 완료 · 승인 대기',done_card,[
 st('바로 승인됨', '<div class="col" style="gap: 10px; padding: 18px; border-radius: 12px; background: var(--wds-background-status-positive); width: 100%; text-align: center; align-items: center"><span class="t-t3">가입을 마쳤어요</span><span class="t-b1 c-neu">바로 로그인해서 쇼핑몰을 준비할 수 있어요.</span><a class="btn btn-lg" href="AU-002.dc.html">로그인하기</a></div>'),
 st('확인 필요 · 승인 대기', '<div class="msg msg-info" style="width: 100%"><b>확인이 필요한 항목이 있어요.</b> 살펴본 뒤 결과를 알려 드려요. 그 전에는 로그인할 수 없어요.</div><a class="btn btn-sm btn-out" href="AU-005.dc.html">신청 상태 보기</a>'),
 st('신청 뒤 다시 들어옴', '<div class="msg msg-info" style="width: 100%">이미 신청을 받았어요 · 결과는 메일과 알림톡으로 알려 드려요</div><span class="t-c1 c-alt">가입 신청 주소로 다시 들어오면 이 화면만 보여요 · 「이전 단계」는 없어요</span>'),
],1400,width=640)
for bid,html in FILES.items():
    for o in OUT: open(o+bid+'.dc.html','w').write(html)
print('written',list(FILES))
