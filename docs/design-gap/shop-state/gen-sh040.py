#!/usr/bin/env python3
"""SH-040 쇼핑몰 준비 중·일시 정지 안내 FINAL + SA-060 운영 상태 안내 문구.
사용: gen-sh040.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>
입력은 반드시 캔버스 아티팩트에서 읽은 최신 사본이어야 한다(저장소 사본 금지)."""
import sys, re, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:60], s.count(old))
    return s.replace(old, new)

CT_PREP = ('<div class="ct"><span class="ico">별</span><h1>곧 문을 열어요</h1>'
           '<p>카드숍 별빛이 문 열 준비를 하고 있어요.<br>이미 주문한 내역은 확인할 수 있어요.</p>'
           '<div><a class="btn p" href="SH-021.dc.html">내 주문 보기</a></div></div>')
HINT_PREP = '<span class="hint" style="text-align: center">새 주문 · 장바구니 · 회원가입은 문을 열면 할 수 있어요</span>'

def st(tag, inner):
    return ('<div class="st"><span class="st-tag">%s</span><div class="col" style="width: 100%%; text-align: left; gap: 8px; align-items: flex-start">'
            '<div class="sh24" style="width: 100%%; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; background: transparent">%s</div></div></div>' % (tag, inner))

STATES = ('<span class="states-h">상태 변형</span>\n'
  + st('일시 정지', '<div class="ct"><span class="ico">!</span><h1>지금은 잠시 쉬고 있어요</h1>'
       '<p>이미 주문한 내역은 확인할 수 있어요.<br>진행 중인 주문은 그대로 처리돼요.</p>'
       '<div><a class="btn p" href="SH-021.dc.html">내 주문 보기</a></div></div>'
       '<span class="hint">새 주문 · 장바구니 · 회원가입은 다시 열면 할 수 있어요</span>')
  + st('결제 기다리는 주문 있음', '<div class="msg inf">결제를 기다리는 주문이 1건 있어요. 쉬는 동안에도 결제는 이어서 할 수 있어요.</div>'
       '<a class="btn s" href="SH-022.dc.html">결제 이어하기</a>')
  + st('내 주문 보기 (로그인 전)', '<div class="msg inf">내 주문은 로그인한 뒤 볼 수 있어요 · 로그인 · 주문 내역 · 주문 상세 · 결제 대기 주문의 결제만 열려요 · 새 주문 · 장바구니 · 회원가입은 닫혀요</div>'
       '<a class="btn s" href="SH-010.dc.html">로그인하기</a>')
  + st('상품 링크로 들어옴', '<div class="msg inf">홈 · 상품 · 장바구니 · 회원가입 주소로 들어와도 이 화면이 떠요. 판매자 사정은 적지 않아요.</div>')
  + '\n')

# --- SH-040 (휴대폰) ---
m = (src / 'SH-040.dc.html').read_text()
m = rep(m, '<title>쇼핑몰 준비 중</title>', '<title>쇼핑몰 준비 중 · 일시 정지 안내</title>')
m = re.sub(r'<div class="mbody"[^>]*>.*?</div></div><div class="states"',
           '<div class="mbody" style="justify-content: center; padding: 0 16px 56px; display: flex; flex-direction: column; gap: 8px">'
           + CT_PREP + HINT_PREP + '</div></div><div class="states"', m, count=1, flags=re.S)
m = re.sub(r'<span class="states-h">상태 변형</span>\n.*?\n</div>\n</div>\n</x-dc>', STATES + '</div>\n</div>\n</x-dc>', m, count=1, flags=re.S)
(out / 'SH-040.dc.html').write_text(m)

# --- SH-040-PC ---
p = (src / 'SH-040-PC.dc.html').read_text()
p = rep(p, '<title>쇼핑몰 준비 중</title>', '<title>쇼핑몰 준비 중 · 일시 정지 안내 (PC)</title>')
p = rep(p, '<a href="SH-011-PC.dc.html">회원가입</a>', '')
p = re.sub(r'<main class="main">.*?</main>',
           '<main class="main"><div style="width: 640px; margin: 48px auto; display: flex; flex-direction: column; gap: 8px">'
           + CT_PREP.replace('SH-021.dc.html', 'SH-021-PC.dc.html') + HINT_PREP + '</div></main>', p, count=1, flags=re.S)
p = re.sub(r'<span class="states-h">상태 변형</span>\n.*?\n</div>\n</div>\n</x-dc>', STATES.replace('SH-021.dc.html', 'SH-021-PC.dc.html').replace('SH-010.dc.html', 'SH-010-PC.dc.html') + '</div>\n</div>\n</x-dc>', p, count=1, flags=re.S)
(out / 'SH-040-PC.dc.html').write_text(p)

# --- SA-060 운영 상태 안내 ---
a = (src / 'SA-060.dc.html').read_text()
a = rep(a, '준비 중 · 일시 정지는 구매자에게 안내 화면만 보이고 주문 조회만 열립니다',
        '준비 중 · 일시 정지는 구매자에게 안내 화면만 보이고 본인 주문 조회만 열립니다 · 이미 받은 주문은 결제 · 처리할 수 있습니다')
a = rep(a, '구매자에게는 준비 중 안내만 보이고 주문 조회만 열립니다. 진행 중인 방송 주문대기는 계속 처리할 수 있습니다.',
        '구매자에게는 준비 중 안내만 보이고 본인 주문 조회만 열립니다. 이미 받은 주문은 결제 · 처리할 수 있고, 진행 중인 방송 주문대기도 계속 처리할 수 있습니다.')
(out / 'SA-060.dc.html').write_text(a)

# --- SA-001 「채팅 수집」 잔존 5곳 → 「채팅 가져오기」(#750 CHAT_NOTICE · #754 토글 문구와 일치) ---
c = (src / 'SA-001.dc.html').read_text()
c = rep(c, '채팅 수집을 끄면', '채팅 가져오기를 끄면')
c = rep(c, '채팅 수집이 멈췄습니다', '채팅 가져오기가 멈췄습니다')
n_rest = c.count('채팅 수집')
c = c.replace('채팅 수집', '채팅 가져오기')
assert '채팅 수집' not in c
(out / 'SA-001.dc.html').write_text(c)
print('SA-001 치환', 2 + n_rest)
print('ok')
