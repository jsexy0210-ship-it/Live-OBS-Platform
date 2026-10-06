#!/usr/bin/env python3
"""보드 반영 묶음 11 — 화면 대조 전담 PF·AU(#928) 요청: PF-003 요금 안내 「요금 · 결제 질문」 답변 본문.
① PF-003: 접혀 있던 질문 3개(결제 실패 · 해지 데이터 · 요금 변경)를 펼쳐 답변 본문을 정본에 둔다(해요체).
   근거: docs/PRODUCT_SCOPE.md:32 결제 실패·잠금·해지(하루 간격 3번 재시도 · 7일 유예 뒤 잠금 · 30일 뒤 자동 해지 · 90일 보관 · 주문·결제 기록 5년)
         :33 구독 기간 계산(원래 결제일부터) · :34 가격 변경 적용(신규 즉시 · 기존 30일 전 알림 뒤 다음 결제부터) · :183 런칭 할인 · :221 해지는 결제 기간 끝까지 사용
사용: gen-board-sync11.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>"""
import sys, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))

P = '<p class="t-b2 c-neu" style="line-height: 1.6; padding: 0 0 16px">'
def qa(q, a):
    return (f'<span class="t-hl2">{q}</span><span class="c-alt">+</span></button></div>',
            f'<span class="t-hl2">{q}</span><span class="c-alt">−</span></button>{P}{a}</p></div>')

s = rd('PF-003.dc.html')
assert s.count(P) == 1
s = rep(s, *qa('결제가 실패하면 어떻게 되나요?',
    '결제가 실패하면 하루 간격으로 3번 다시 시도해요. 처음 실패한 날부터 7일까지는 그대로 쓸 수 있고, 그 뒤에는 결제할 때까지 쇼핑몰과 방송 화면이 멈춰요. 결제하면 바로 다시 열리고, 구독 기간은 원래 결제일부터 이어서 세요. 잠긴 지 30일이 지나면 자동으로 해지돼요.'))
s = rep(s, *qa('해지하면 데이터는요?',
    '해지해도 이번 결제 기간이 끝날 때까지는 그대로 쓸 수 있고, 다음 결제부터 청구하지 않아요. 해지한 뒤 90일 동안 자료를 보관하고, 그 안에 다시 구독하면 그대로 되살려요. 90일이 지나면 삭제돼요. 주문 · 결제 기록은 법에서 정한 5년 동안 따로 보관해요. 삭제 전에 메일로 미리 알려 드려요.'))
s = rep(s, *qa('요금이 바뀌면요?',
    '새로 가입하는 분에게는 바뀐 요금이 바로 적용되고, 이미 구독 중이면 30일 전에 메일 · 알림톡 · 파트너스 관리자 공지로 알린 뒤 그다음 결제부터 적용돼요. 런칭 할인이 끝나는 날짜도 정해지면 30일 전에 알려 드려요.'))
assert s.count(P) == 4 and '<span class="c-alt">+</span>' not in s
wr('PF-003.dc.html', s)
