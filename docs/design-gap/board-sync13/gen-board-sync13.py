#!/usr/bin/env python3
"""보드 반영 묶음 13.
① SH-011 회원가입을 단계 화면 4장으로(대표님 지시 2026-10-06 「쇼핑몰도 회원가입 스텝으로 화면 나눠라」, MASTER (4) 전달):
   SH-011-1 약관 동의 → SH-011-2 휴대폰 본인확인(미연동 안내 포함) → SH-011-3 정보 입력(로그인에 꼭 필요한 기본 정보만 · 배송지 없음, PRODUCT_SCOPE:94)
   → SH-011-4 가입 완료. PF-007 단계 규격(진행 표시 · 이전 단계 입력값 유지 · 주소로 바로 들어오면 첫 미완료 단계) 재사용, 구매자 해요체.
   틀(머리 · 바닥 · 탭바)과 상태 문구는 기존 SH-011(v287)에서 그대로 가져온다.
② MA-100 「안전 규칙」 · 「자동 조치 기록」을 실제 동작으로(화면-마스터 B 코드 대조 2026-10-06): 서버 재시작 · 동시성 자동 조정은 코드에 없음,
   자동 조치 = 로그 추적의 시스템 행(환불 요청 생성 · 기한 지난 보완 자동 반려 · 메일 발송), 결제 · 환불 실행은 사람이 승인.
사용: gen-board-sync13.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>"""
import sys, pathlib, re
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))

# ---------- ① SH-011 단계 화면 ----------
base = rd('SH-011.dc.html')
head = base[:base.index('<div class="app"')]                      # doctype ~ helmet
app_open = base[base.index('<div class="app"'):base.index('<div class="sh24 m"')]
back = re.search(r'<a class="mi bk" href="SH-001.dc.html" aria-label="뒤로">.*?</a>', base, re.S).group(0)
mft = base[base.index('<div class="mft">'):base.index('<nav class="tabbar">')]
tabbar = base[base.index('<nav class="tabbar">'):base.index('</nav>') + len('</nav>')]
tail = base[base.index('<script type="text/x-dc"'):]
assert back and mft and tabbar

STEPS = ['약관 동의', '본인확인', '정보 입력', '완료']
def steps(n):
    cells = []
    for i, name in enumerate(STEPS, 1):
        on = i <= n
        circ = (f'<span style="width: 26px; height: 26px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800; '
                + ('background: var(--shop); color: var(--shop-ink)' if on else 'background: var(--ln2); color: var(--sub)') + f'">{i}</span>')
        label = f'<b style="font-size: 13px">{name}</b>' if i == n else ''
        arrow = '<span style="width: 12px; height: 1px; background: var(--ln2)"></span>' if i < 4 else ''
        cells.append(f'<span style="display: inline-flex; align-items: center; gap: 6px">{circ}{label}</span>{arrow}')
    return (f'<div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0 0 16px"><b style="font-size: 13px; color: var(--shop); margin-right: 4px">{n} / 4</b>' + ''.join(cells) + '</div>')

def field(label, typ, val, ph, hint='', req=True, err=''):
    rq = '<span style="color: var(--neg)">*</span>' if req else ''
    cls = 'inp w-f err' if err else 'inp w-f'
    h = f'<span class="hint" style="margin: 0">{hint}</span>' if hint else ''
    e = f'<span class="err" style="margin: 0">{err}</span>' if err else ''
    return (f'<div style="display: flex; flex-direction: column; gap: 4px"><label style="font-size: 12px; font-weight: 700">{label}{rq}</label>'
            f'<input class="{cls}" type="{typ}" value="{val}" placeholder="{ph}">{h}{e}</div>')
def nav(prev, nxt, nxt_label='다음', nxt_dis=False):
    p = f'<a class="btn l" href="{prev}" style="flex: 1">이전 단계</a>' if prev else '<a class="btn l" href="SH-001.dc.html" style="flex: 1">취소</a>'
    n = (f'<button class="btn l p" type="button" disabled style="flex: 1">{nxt_label}</button>' if nxt_dis
         else f'<a class="btn l p" href="{nxt}" style="flex: 1">{nxt_label}</a>')
    return f'<div style="display: flex; gap: 8px; margin-top: 4px">{p}{n}</div>'
KEEP = '<span class="hint" style="margin: 0">입력한 내용은 새로고침하거나 뒤로 가도 남아 있어요(비밀번호는 빼고) · 이전 단계로 돌아가도 그대로예요</span>'
LOGIN = '<div style="text-align: center; font-size: 13px; color: var(--sub)">이미 회원이에요? <a href="SH-010.dc.html" style="color: var(--ink); font-weight: 700; text-decoration: underline">로그인</a></div>'
COL = '<div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start"><div class="sh24" style="width: 100%; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; background: transparent">'
def st(tag, inner): return f'<div class="st"><span class="st-tag">{tag}</span>{COL}{inner}</div></div></div>'
def phone(n, title_hint, body, back_href):
    return (app_open + '<div class="sh24 m" style="border: 1px solid var(--c24-line, #d3d7de); box-sizing: content-box; flex: none"><div class="mh sub">'
            + back.replace('href="SH-001.dc.html"', f'href="{back_href}"') + '<span class="tt">회원가입</span><span class="rr"><a class="mi" href="SH-001.dc.html" aria-label="홈">⌂</a><a class="mi" href="SH-004.dc.html" aria-label="장바구니">▣</a></span></div>'
            + '<div class="mbody"><div class="sh24" style="padding: 24px 16px"><h1 style="margin: 0 0 4px; font-size: 20px">회원가입</h1>'
            + f'<div class="hint" style="margin: 0 0 12px">{title_hint}</div>' + steps(n)
            + '<div style="display: flex; flex-direction: column; gap: 12px">' + body + '</div></div>' + mft + tabbar + '</div>')  # mft 조각이 mbody 닫는 태그까지 포함
def board(fname, title, n, title_hint, body, back_href, states):
    s = head.replace('<title>', '<title>', 1)
    s = re.sub(r'<title>[^<]*</title>', f'<title>{title}</title>', s, count=1)
    s += phone(n, title_hint, body, back_href)
    s += '<div class="states" style="display: flex; flex-direction: column; flex: 1; min-width: 0; padding: 0; box-shadow: none; background: transparent">\n<span class="states-h">상태 변형</span>\n' + '\n'.join(states) + '\n</div>\n</div>\n</x-dc>\n' + tail
    assert s.count('<x-dc>') == 1 and s.count('</x-dc>') == 1
    wr(fname, s)

# 공통 상태(모든 단계)
ST_DIRECT = st('앞 단계 없이 주소로 바로 들어옴', '<div class="msg inf">앞 단계부터 진행해 주세요. 약관 동의로 돌아가요</div><span class="hint">어느 단계 주소로 들어와도 첫 미완료 단계로 보내요 · 끝낸 단계의 입력값은 그대로예요 · 로그인 상태면 홈으로</span>')
ST_PC = st('PC (SH-011-PC)', '<span class="hint">PC도 같은 4단계 · 같은 주소예요 · 가운데 카드 480 · 단계 표시 · 버튼 · 문구 · 상태 변형은 이 보드(SH-011-1~4)를 그대로 따라요 · 주소: /signup(약관) → /signup/verify(본인확인) → /signup/account(정보 입력) → /signup/done(완료)</span>')

# SH-011-1 약관 동의
terms = ('<div class="box"><div class="bd" style="display: flex; flex-direction: column; gap: 8px; padding: 12px 16px"><div style="padding-bottom: 8px; border-bottom: 1px solid var(--ln2)"><label class="ck"><input type="checkbox" name="r" checked><b>모두 동의해요</b></label></div>'
         '<div style="display: flex; align-items: center"><label class="ck"><input type="checkbox" name="r" checked>이용약관 동의 (필수)</label><a href="SH-032.dc.html" style="margin-left: auto; font-size: 12px; color: var(--sub); text-decoration: underline">보기</a></div>'
         '<div style="display: flex; align-items: center"><label class="ck"><input type="checkbox" name="r" checked>개인정보 수집 · 이용 동의 (필수)</label><a href="SH-031.dc.html" style="margin-left: auto; font-size: 12px; color: var(--sub); text-decoration: underline">보기</a></div>'
         '<div style="display: flex; align-items: center"><label class="ck"><input type="checkbox" name="r" checked>만 14세 이상이에요 (필수)</label><a href="#" style="margin-left: auto; font-size: 12px; color: var(--sub); text-decoration: underline">보기</a></div>'
         '<div style="display: flex; align-items: center"><label class="ck"><input type="checkbox" name="r">방송 · 혜택 알림 받기 (선택)</label><a href="#" style="margin-left: auto; font-size: 12px; color: var(--sub); text-decoration: underline">보기</a></div></div></div>'
         '<span class="hint" style="margin: 0">다음 단계는 휴대폰 본인확인이에요 · 배송지는 가입 때 받지 않고 첫 주문 때 입력해요</span>')
board('SH-011-1.dc.html', '회원가입 1/4 · 약관 동의', 1, '휴대폰 본인확인으로 가입해요 · 4단계',
      terms + nav(None, 'SH-011-2.dc.html') + LOGIN, 'SH-001.dc.html',
      [st('필수 약관 미동의', '<div class="msg neg">필수 약관에 동의해 주세요</div><button class="btn l p" type="button" disabled>다음</button>'),
       st('약관이 바뀜 (돌아왔을 때)', '<div class="msg cau">약관이 바뀌었어요. 다시 확인해 주세요</div><span class="hint">동의한 약관 버전을 서버가 함께 저장해요 · 버전이 다르면 이 단계로 돌려보내요</span>'),
       st('이전 단계 입력값 유지', KEEP), ST_DIRECT, ST_PC,
       st('가입 뒤 이동', '<span class="hint">가입을 마치면 로그인 상태로 「들어오기 전 화면」(상품 상세 · 장바구니 · 주문서)으로 돌아가요 · 홈에서 왔으면 홈 · 2026.10.05 IA 개편 보강</span>')])

# SH-011-2 휴대폰 본인확인
verify = (field('이름', 'text', '', '본인 이름') + field('생년월일', 'text', '', '예: 19990101', '숫자 8자리')
          + '<div style="display: flex; flex-direction: column; gap: 4px"><label style="font-size: 12px; font-weight: 700">통신사<span style="color: var(--neg)">*</span></label><select class="inp w-f"><option selected>통신사 선택</option><option>SKT</option><option>KT</option><option>LG U+</option><option>알뜰폰</option></select></div>'
          + field('휴대폰번호', 'tel', '', '숫자만 입력')
          + '<label class="ck"><input type="checkbox" name="r">본인확인 이용 약관에 모두 동의해요</label>'
          + '<button class="btn l p f" type="button">인증번호 문자 받기</button>'
          + '<span class="hint" style="margin: 0">본인 명의 휴대폰으로 확인해요 · 이름 · 생년월일 · 번호가 가입 정보에 들어가고 바꿀 수 없어요 · 같은 휴대폰으로는 이 쇼핑몰에 한 번만 가입할 수 있어요</span>'
          + nav('SH-011-1.dc.html', 'SH-011-3.dc.html', nxt_dis=True) + KEEP)
board('SH-011-2.dc.html', '회원가입 2/4 · 휴대폰 본인확인', 2, '본인 명의 휴대폰으로 확인해요',
      verify, 'SH-011-1.dc.html',
      [st('인증번호 입력', '<div class="msg inf">인증번호를 보냈어요. 문자로 받은 6자리를 넣어 주세요</div>' + field('인증번호', 'text', '', '6자리', '남은 시간 2:58 · 못 받았으면 「다시 받기」') + '<div style="display: flex; gap: 8px; width: 100%"><button class="btn l" type="button" style="flex: 1">다시 받기</button><button class="btn l p" type="button" style="flex: 1">인증번호 확인하기</button></div>'),
       st('본인확인 완료 → 다음 활성', '<div class="box" style="width: 100%"><div class="bd" style="display: flex; align-items: center; gap: 12px; padding: 12px 16px"><span class="tag gr">본인확인 완료</span><div style="flex: 1"><b>김별빛</b> · [휴대폰 번호] · 1995년생<div class="hint" style="margin: 0">방금 확인했어요 · 바꿀 수 없어요</div></div><button class="btn s" type="button">다시 하기</button></div></div>' + nav('SH-011-1.dc.html', 'SH-011-3.dc.html')),
       st('실패 · 번호 틀림', field('인증번호', 'text', '123455', '6자리', err='문자로 받은 6자리를 다시 확인해 주세요. 2번 더 넣을 수 있어요')),
       st('본인확인 실패 · 취소', '<div class="msg neg"><b>본인확인이 끝나지 않았어요.</b> 창을 닫았거나 통신사 확인에 실패했어요. 다시 해 주세요.</div><button class="btn s p" type="button">다시 본인확인</button>'),
       st('이미 가입한 사람', '<div class="msg inf">이 휴대폰으로 가입한 계정이 있어요 · sta****@example.com (2026.06.12 가입)</div><a class="btn s" href="SH-010.dc.html">그 계정으로 로그인</a><span class="hint">여기서 막히고 다음 단계로 가지 않아요</span>'),
       st('만 14세 미만', '<div class="msg neg"><b>만 14세 미만은 가입할 수 없어요.</b> 본인확인 생년월일 기준이에요.</div>'),
       st('탈퇴한 지 30일 안 (재가입 보관 동의)', '<div class="msg inf">최근에 탈퇴한 계정이 있어요 · 30일 안에는 같은 정보로 다시 가입해도 이전 주문 · 적립금이 돌아오지 않아요.</div><label class="ck"><input type="checkbox" name="r">이전 정보가 복구되지 않는 걸 확인했어요</label>'),
       st('본인확인 서비스 준비 중 (대행사 계약 전 · 미연동)', '<div class="msg cau"><b>지금은 가입할 수 없어요.</b> 휴대폰 본인확인 서비스를 준비하고 있어요. 준비되면 알려 드릴게요.</div><button class="btn l p f" type="button" disabled>인증번호 문자 받기</button><span class="hint">본인확인 대행사 계약 전에는 이 단계에서 멈춰요 · 입력칸과 버튼이 잠겨요 · 비회원으로 상품은 볼 수 있어요</span>'),
       st('테스트 서버만 · 본인확인 안내줄', '<div class="msg inf">테스트 모드예요. 인증번호 000000을 넣어 주세요</div><span class="hint">운영에서는 보이지 않아요</span>'),
       st('이전 단계 입력값 유지', KEEP), ST_DIRECT])

# SH-011-3 정보 입력
account = ('<div class="box"><div class="bd" style="display: flex; align-items: center; gap: 12px; padding: 12px 16px"><span class="tag gr">본인확인 완료</span><div style="flex: 1"><b>김별빛</b> · [휴대폰 번호] · 1995년생<div class="hint" style="margin: 0">휴대폰 본인확인으로 이름 · 생년월일 · 번호를 받았어요 · 바꿀 수 없어요</div></div></div></div>'
           + field('아이디 (이메일)', 'email', '', 'example@email.com', '주문 · 배송 안내 메일을 받는 주소예요')
           + field('비밀번호', 'password', '', '8자 이상', '8자 이상 · 영문과 숫자를 섞어 주세요')
           + field('비밀번호 확인', 'password', '', '한 번 더 입력')
           + field('방송 닉네임', 'text', '', '방송에서 보일 이름', '방송 화면에 보이는 이름이에요. 실명은 쓰지 마세요.')
           + '<span class="hint" style="margin: 0">로그인에 꼭 필요한 정보만 받아요 · 배송지는 첫 주문 때 입력해요</span>'
           + nav('SH-011-2.dc.html', 'SH-011-4.dc.html', '가입하기'))
board('SH-011-3.dc.html', '회원가입 3/4 · 정보 입력', 3, '로그인에 쓸 정보만 입력해요',
      account, 'SH-011-2.dc.html',
      [st('아이디(이메일) 중복', field('아이디 (이메일)', 'email', 'star@example.com', 'example@email.com', err='이미 가입한 아이디예요. 로그인하거나 다른 주소를 써 주세요') + '<a class="btn s" href="SH-010.dc.html">로그인</a>'),
       st('닉네임 중복', field('방송 닉네임', 'text', '카드왕', '방송에서 보일 이름', err='이미 쓰는 닉네임이에요. 다른 이름을 골라 주세요')),
       st('비밀번호 규칙 · 확인 불일치', field('비밀번호', 'password', '••••', '8자 이상', err='8자 이상 · 영문과 숫자를 섞어 주세요') + field('비밀번호 확인', 'password', '••••••••', '한 번 더 입력', err='비밀번호가 서로 달라요')),
       st('가입하는 중', '<button class="btn l p f" type="button" disabled>가입하는 중</button><span class="hint">요청 중에는 버튼 · 이전 단계가 잠겨요 · 오류면 다시 열려요</span>'),
       st('이전 단계로 돌아감', '<span class="hint">「이전 단계」로 가도 본인확인 결과는 그대로예요 · 다시 하려면 2단계의 「다시 하기」 · 비밀번호 칸만 비워져요</span>'), ST_DIRECT])

# SH-011-4 가입 완료
done = ('<div class="ct"><span class="ico">✓</span><h1>가입했어요</h1><p>첫 주문부터 적립돼요 · 배송지는 첫 주문 때 입력해요</p><div><a class="btn p" href="SH-001.dc.html">쇼핑 계속하기</a></div></div>'
        '<span class="hint" style="margin: 0; text-align: center">로그인된 상태예요 · 「들어오기 전 화면」이 있으면 그리로 돌아가요</span>')
board('SH-011-4.dc.html', '회원가입 4/4 · 가입 완료', 4, '가입이 끝났어요',
      done, 'SH-001.dc.html',
      [st('가입 완료 토스트', '<div class="toast">가입했어요. 첫 주문부터 적립돼요</div>'),
       st('가입 뒤 이동', '<span class="hint">로그인 상태로 「들어오기 전 화면」(상품 상세 · 장바구니 · 주문서)으로 돌아가요 · 홈에서 왔으면 홈 · 「이전 단계」는 없어요</span>'),
       st('가입 주소로 다시 들어옴', '<div class="msg inf">이미 가입했어요 · 로그인 상태예요</div><span class="hint">로그인 상태에서 가입 주소로 들어오면 홈으로 보내요</span>'), ST_PC])

# ---------- ② MA-100 안전 규칙 · 자동 조치 기록 ----------
s = rd('MA-100.dc.html')
s = rep(s, '<div class="note " style="width: 100%">재시작은 10분에 1회 · 동시성은 상한 안에서만 · 결제 · 환불은 자동 조치 안 함</div>',
        '<div class="note " style="width: 100%">자동 조치는 시스템이 스스로 한 처리(환불 요청 생성 · 기한 지난 보완 요청 자동 반려 · 결정 · 주문 메일 발송 등)를 로그 추적에 남기는 것입니다 · 서버 재시작 · 동시성 조정은 자동으로 하지 않습니다 · 결제 · 환불 실행은 사람이 승인합니다(시스템은 환불 요청만 만듭니다)</div>')
s = rep(s, '<tr><td>16:02:41</td><td>작업 서버 2 재시작</td><td>결제 검증 지연 · 성공</td></tr><tr><td>15:58:12</td><td>중복 이벤트 제거</td><td>카드숍 별빛 · 3 → 1건</td></tr><tr><td>15:41:06</td><td>자동 연결 동시성 2 → 4</td><td>상한 6 안</td></tr>',
        '<tr><td>16:02:41</td><td>환불 요청 생성</td><td>해지된 파트너스 결제 확정 · 1건 · 승인은 최고관리자</td></tr><tr><td>15:58:12</td><td>보완 기한 지나 자동 반려</td><td>가입 신청 1건 · 결과 메일 발송</td></tr><tr><td>15:41:06</td><td>주문 메일 발송</td><td>구매자 주문 · 배송 안내 12건</td></tr>')
s = rep(s, '<span class="hint">대기 중 조치 없음</span>', '<span class="hint">로그 추적의 시스템 행 최근 20건 · 대기 중 조치 없음</span>')
s = rep(s, '<td>작업 서버 재시작 · 결제 재검증 대기열로 이동</td>', '<td>없음 · 사람 판단 필요</td>')
s = rep(s, '<td>동시성 +2 (상한 안)</td>', '<td>기록만</td>')
s = rep(s, '자동 조치(재시작 2회)로 풀리지 않았습니다.', '자동으로 풀리지 않았습니다.')
for bad in ['재시작', '동시성']: assert bad not in s.replace('서버 재시작 · 동시성 조정은 자동으로 하지 않습니다', ''), bad
wr('MA-100.dc.html', s)
