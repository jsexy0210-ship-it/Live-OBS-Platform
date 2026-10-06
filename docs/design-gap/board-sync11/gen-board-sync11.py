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
if s.count(P) == 1:  # v330 원본 (이미 반영된 사본에서는 건너뜀)
  s = rep(s, *qa('결제가 실패하면 어떻게 되나요?',
    '결제가 실패하면 하루 간격으로 3번 다시 시도해요. 처음 실패한 날부터 7일까지는 그대로 쓸 수 있고, 그 뒤에는 결제할 때까지 쇼핑몰과 방송 화면이 멈춰요. 결제하면 바로 다시 열리고, 구독 기간은 원래 결제일부터 이어서 세요. 잠긴 지 30일이 지나면 자동으로 해지돼요.'))
  s = rep(s, *qa('해지하면 데이터는요?',
    '해지해도 이번 결제 기간이 끝날 때까지는 그대로 쓸 수 있고, 다음 결제부터 청구하지 않아요. 해지한 뒤 90일 동안 자료를 보관하고, 그 안에 다시 구독하면 그대로 되살려요. 90일이 지나면 삭제돼요. 주문 · 결제 기록은 법에서 정한 5년 동안 따로 보관해요. 삭제 전에 메일로 미리 알려 드려요.'))
  s = rep(s, *qa('요금이 바뀌면요?',
    '새로 가입하는 분에게는 바뀐 요금이 바로 적용되고, 이미 구독 중이면 30일 전에 메일 · 알림톡 · 파트너스 관리자 공지로 알린 뒤 그다음 결제부터 적용돼요. 런칭 할인이 끝나는 날짜도 정해지면 30일 전에 알려 드려요.'))
assert s.count(P) == 4 and '<span class="c-alt">+</span>' not in s
wr('PF-003.dc.html', s)

# ③ MA-100 실시간 감시 — 구현(app/(admin)/admin/(shell)/ops/monitor/page.tsx)에 있는 서버 실제 값 섹션 2개를 정본에 추가
#    (MASTER (4) 요청 2026-10-06: 서버에 있는 정보는 정본에서 없애지 않음) · 종류 라벨 app/(admin)/admin/_components/ops.ts PAYMENT_CHECK ·
#    정기 작업 이름 lib/server/jobs/scheduler.ts(23개) · 상태 라벨 JOB_STATUS(성공 · 건너뜀 · 실패 · 신호 없음)
s = rd('MA-100.dc.html')
TAG = {'정상': 'g', '실패': 'r', '건너뜀': 'n', '신호 없음': 'y'}
JOBS = [('infra_snapshot.collect', '정상', '16:03:00', '16:03:00', '2대', '-'),
        ('infra_alerts.evaluate', '정상', '16:03:01', '16:03:01', '2대', '-'),
        ('external_webhook_event.process', '정상', '16:02:50', '16:02:50', '2대', '-'),
        ('seller_application.send_decision_mails', '정상', '16:02:30', '16:02:30', '2대', '-'),
        ('order_mail.send_buyer_mails', '실패', '16:02:00', '15:47:00', '2대', '메일 서버 연결 시간 초과'),
        ('reward.settle_pending', '정상', '16:00:00', '16:00:00', '2대', '-'),
        ('delivery_tracking.lookup', '건너뜀', '16:00:00', '15:00:00', '2대', '배송 조회 업체가 없어 조회하지 않음'),
        ('member_grade.recalc_monthly', '정상', '10.01 00:05', '10.01 00:05', '1대', '-')]
jobs = ''.join(f'<tr><td class="l">{n}</td><td><span class="tag {TAG[st]}">{st}</span></td><td>{a}</td><td>{b}</td><td>{sv}</td><td class="l">{e}</td></tr>' for n, st, a, b, sv, e in JOBS)
PAY = [('주문 결제 승인', '3건', '15:58:40'), ('구독 청구', '1건', '16:01:12'), ('자동 연결 결제', '0건', '—'), ('발송 · 이용 충전', '0건', '—')]
pay = ''.join(f'<tr><td class="l">{k}</td><td>{n}</td><td>{t}</td></tr>' for k, n, t in PAY)
NEW = ('<div class="sec-t">결제 결과 확인 대기</div><table class="lt" style="max-width: 720px"><thead><tr><th>종류</th><th style="width: 100px">대기</th><th style="width: 160px">가장 오래된 시각</th></tr></thead><tbody>' + pay + '</tbody></table>'
       '<span class="hint">결제대행사 결과를 아직 확인하지 못한 결제입니다 · 종류별 대기 건수와 가장 오래된 시각 · 대기가 0건이면 시각은 비워 둡니다</span>'
       '<div class="sec-t">자동으로 도는 작업<span class="nt">23개 · 정상 21 · 이상 2</span></div><table class="lt"><thead><tr><th>작업</th><th style="width: 90px">상태</th><th style="width: 120px">마지막 실행</th><th style="width: 160px">마지막으로 성공한 때</th><th style="width: 70px">서버</th><th>오류</th></tr></thead><tbody>' + jobs + '</tbody></table>'
       '<span class="hint">서버에 등록된 정기 작업 전부를 보입니다(이름은 서버 등록 이름 그대로) · 마지막 실행이 실패 · 신호 없음이면 이상으로 셉니다 · 기록된 정기 실행이 없으면 「기록된 정기 실행이 없습니다」</span>')
s = rep(s, '결제 · 환불은 자동 조치 안 함</div></div></div>\n</main>', '결제 · 환불은 자동 조치 안 함</div></div></div>' + NEW + '\n</main>')
assert s.count('<div class="sec-t">') == 5
wr('MA-100.dc.html', s)
