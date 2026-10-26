#!/usr/bin/env python3
"""묶음 28 — SA-152 자동 연결 진행 정본을 서버 · 구현에 맞춤 (대표님 결정 2026-10-16, MASTER (5) 전달).
근거: lib/server/automation/steps.ts(5단계 + 결제 확인 = 6단계) · jobs.ts(pauseJob: QUEUED · RUNNING · VERIFYING 만, 고객 확인 대기 · 끝난 작업은 409 invalid_state;
continueJob: 멈춘 단계부터; getJobTimeline 작업 기록) · components/seller/automation/common.ts(STEP_LABEL · ACTION_TEXT · ERROR_TEXT · 상태 이름)
· app/(seller)/seller/(shell)/automation/[jobId]/page.tsx(상태별 버튼: 자동 설정 그만두기 · 이어서 진행하기 · N원 환불 요청하기 · 자동 설정 다시 하기 · 직접 설정하러 가기).
정본에만 있고 구현에서 못 찾은 것(쇼핑몰 이름 · 주소 · 「관리자 창 열기」 · 「도구 내려받기」 · 되돌린 항목 목록 · 「대기 중 · N분」 경과 분 · 무료 재시도 · 완료 시각)은 지우지 않고 「구현 미확인」으로 표기한다.
작업 기록 표 · 잠시 멈추기 · 이어 하기 · 할 일 표(customerChecklist 5줄 · 줄별 완료 버튼, page.tsx:144-163)는 #1007 소스 반영 · 실화면 동작 미검증 — 정본은 그 구조를 그대로 둔다.
재현성: 이 스크립트 한 번으로 보드가 완성된다(사후 수동 편집 없음, Codex 리뷰 2026-10-17 #1235).
사용: gen-sa152.py <design/project 디렉터리> (제자리 수정 · PC 1440 정본만)"""
import sys, pathlib
src = pathlib.Path(sys.argv[1]); p = src / 'SA-152.dc.html'
t = p.read_text(encoding='utf-8')
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:80], s.count(old), n); return s.replace(old, new)
UNV = '<span class="nt">(구현 미확인 2026-10-16)</span>'
REFUND = '[자동 연결 요금]원은 결제한 카드로 환불됩니다 · 카드사 기준 3~5일(주말·공휴일 제외) · 직접 설정은 무료로 계속 할 수 있습니다'
CHECKLIST = ('<table class="lt"><thead><tr><th>할 일</th><th style="width: 160px">처리</th></tr></thead><tbody>'
             '<tr><td class="l">쇼핑몰 관리자에 로그인해 주십시오</td><td><span class="tag g">완료</span></td></tr>'
             '<tr aria-current="true"><td class="l">2단계 인증을 완료해 주십시오</td><td><button class="b sm" type="button">인증 완료</button></td></tr>'
             '<tr><td class="l">보안문자가 뜨면 직접 입력해 주십시오</td><td><button class="b sm" type="button">입력 완료</button></td></tr>'
             '<tr><td class="l">ONQ 앱 설치 권한을 승인해 주십시오</td><td><button class="b sm" type="button">승인 완료</button></td></tr>'
             '<tr><td class="l">방송용 PC에 OBS 연결 도구를 설치해 주십시오</td><td><button class="b sm" type="button">설치 완료</button> <button class="b sm" type="button">도구 내려받기</button> ' + UNV + '</td></tr>'
             '</tbody></table><span class="hint">아이디 · 비밀번호는 저장하지 않습니다 · 2026.10.03 21:07까지 확인해 주십시오 · 마친 뒤 이어서 진행하기를 누르면 자동으로 이어 갑니다</span>')
CHECK_NOTE = '<span class="hint">줄별 「완료」는 표시용(서버 customerActionsDone) · 작업자는 customerAction 한 줄을 기다립니다 · 「이어서 진행하기」는 확인 창 「이어서 진행하시겠습니까?」를 거칩니다 · 24시간이 지나면 실패 · 환불 안내</span>'
END_BTNS = '<button class="b sm pri" type="button">[자동 연결 요금]원 환불 요청하기</button><a class="b sm" href="SA-150.dc.html">자동 설정 다시 하기</a><a class="b sm" href="SA-002.dc.html">직접 설정하러 가기</a>'

# 머리 버튼: 고객 확인 대기 중에는 「잠시 멈추기」가 서버 409 → 비활성 · 취소 버튼 이름은 구현 그대로
t = rep(t, '<div class="acts"><button class="b " type="button">잠시 멈추기</button><button class="b " type="button">자동 설정 그만두기</button></div>',
        '<div class="acts"><button class="b " type="button" disabled title="직접 해 주셔야 하는 동안에는 멈출 수 없습니다">잠시 멈추기</button><button class="b " type="button">자동 설정 그만두기</button></div>')
# 상태 띠: 구현 상태 이름 + 결제 상태. 쇼핑몰 이름 · 주소는 구현 미확인 표기
t = rep(t, '<div class="note cau" style="width: 100%"><b>고객 확인 필요</b> · 카드숍 별빛 · [쇼핑몰 주소] · 2026.10.02 21:05 시작 · 결제 확인됨</div>',
        '<div class="note cau" style="width: 100%"><span class="tag y">직접 해 주셔야 함</span> 2026.10.02 21:05 시작 · 결제 확인됨 · 카드숍 별빛 · [쇼핑몰 주소] ' + UNV + '</div>')
# 단계 줄: 서버 6단계(결제 확인 + 5단계, 이름은 구현 STEP_LABEL)
t = rep(t, '<div class="rtabs"><a class="" href="#" style="color: #1b7f3b">✓ 결제 확인</a><a class="on" href="#">2 외부 쇼핑몰 연결</a><a class="" href="#">3 방송 화면 넣기</a><a class="" href="#">4 주문 표시 설정</a><a class="" href="#">5 테스트 검증</a></div>',
        '<div class="rtabs"><a class="" href="#" style="color: #1b7f3b">✓ 결제 확인</a><a class="on" href="#">2 다른 쇼핑몰 이어 주기</a><a class="" href="#">3 주문 알림 연결</a><a class="" href="#">4 방송 프로그램에 방송 화면 넣기</a><a class="" href="#">5 주문 표시 설정</a><a class="" href="#">6 테스트 확인</a></div>')
# 지금 해 주실 일: 구현(page.tsx:144-163) 그대로 할 일 표 5줄(customerChecklist · CHECK_TEXT · 줄별 완료 버튼) + 안내 + 「이어서 진행하기」. 관리자 창 열기는 구현 미확인
t = rep(t, '<div class="box" style="padding: 12px 12px"><b>쇼핑몰 관리자에 로그인하고 2단계 인증을 완료해 주십시오</b><div class="nt" style="margin-top: 4px">아래 창이 열립니다 · 아이디 · 비밀번호는 저장하지 않고, 인증이 끝나면 자동으로 이어 갑니다</div><div style="margin-top: 8px"><button class="b pri" type="button">관리자 창 열기</button><button class="b " type="button">인증 완료</button></div></div>',
        '<div class="note cau" style="width: 100%"><b>직접 해 주실 일이 있습니다</b> · 고객 확인 필요 · 24시간 안 · 마치면 자동으로 이어 갑니다 · 24시간이 지나면 실패로 처리하고 환불 안내를 보내 드립니다</div>' + CHECKLIST + '<div style="margin-top: 8px"><button class="b pri" type="button">이어서 진행하기</button><button class="b " type="button">관리자 창 열기</button> ' + UNV + '</div>')
# 작업 기록: 서버 getJobTimeline 종류에 맞춘 행 · 화면 표시는 #1007 소스 반영 · 실화면 동작 미검증
t = rep(t, '<div class="sec-t">작업 기록</div>', '<div class="sec-t">작업 기록<span class="nt">서버 작업 기록(결제 확인 · 시작 · N단계 완료 · 고객 확인 대기 · 이어 감 · 테스트 확인 · 잠시 멈춤 · 이어 하기 · 완료 · 실패 · 취소) · #1007 소스 반영 · 실화면 동작 미검증(작업 기록 표 · 비밀번호 · 인증번호는 기록에 남기지 않습니다)</span></div>')
t = rep(t, '<tr><td class="c">21:06</td><td class="l">쇼핑몰 앱 설치 요청</td></tr><tr><td class="c">21:07</td><td class="l">관리자 로그인 · 2단계 인증이 필요합니다 · 고객 확인 대기</td></tr>',
        '<tr><td class="c">21:06</td><td class="l">실행 시작 · 2단계 다른 쇼핑몰 이어 주기</td></tr><tr><td class="c">21:07</td><td class="l">고객 확인 대기 · 문자 인증</td></tr>')

# ---------- 상태 변형 ----------
# 할 일 목록: 구현 customerChecklist 5줄 · 줄별 완료 버튼(CHECK_TEXT.done) · 「이어서 진행하기」 · 도구 내려받기는 구현 미확인
t = rep(t, '<table class="lt"><thead><tr><th>할 일</th><th>처리</th></tr></thead><tbody><tr><td>쇼핑몰 관리자에 로그인해 주십시오</td><td><span class="tag g">완료</span></td></tr><tr><td>2단계 인증을 완료해 주십시오</td><td><button class="b sm" type="button">인증 완료</button></td></tr><tr><td>보안문자가 뜨면 직접 입력해 주십시오</td><td><button class="b sm" type="button">입력 완료</button></td></tr><tr><td>ONQ 앱 설치 권한을 승인해 주십시오</td><td><button class="b sm" type="button">승인 완료</button></td></tr><tr><td>방송용 PC에 OBS 연결 도구를 설치해 주십시오</td><td><button class="b sm" type="button">도구 내려받기</button></td></tr></tbody></table><button class="b sm pri" type="button">이어서 진행하기</button>',
        CHECKLIST + '<button class="b sm pri" type="button">이어서 진행하기</button>' + CHECK_NOTE)
# 24시간 지남: 구현 ERROR_TEXT · 환불 문구 · 끝 버튼 3개
t = rep(t, '<div class="note neg" style="width: 100%"><b>24시간 안에 확인이 끝나지 않아 실패로 처리했습니다.</b> 결제한 금액(N원)을 전액 환불해 드립니다 · 결제한 카드로 카드사 기준 3~5영업일 · 다시 하고 싶으면 자동 연결을 새로 결제하거나 직접 설정(무료)으로 연결할 수 있습니다</div><button class="b sm pri" type="button">자동 연결 다시 하기</button><button class="b sm" type="button">직접 설정하러 가기</button>',
        '<div class="note neg" style="width: 100%"><b>24시간 안에 확인이 끝나지 않아 실패로 처리했습니다</b> · ' + REFUND + '</div>' + END_BTNS)
# 취소 확인 · 시작 전 / 시작 뒤: 구현 확인 창 문구 · 버튼 「그만두기」
t = rep(t, '<div class="bd">아직 연결을 시작하지 않았습니다. 취소하면 결제한 금액(N원)이 전액 환불됩니다 · 결제한 카드로 카드사 기준 3~5영업일.</div><div class="f"><button class="b pri neg" type="button">취소하고 환불받기</button><button class="b " type="button">계속 진행</button></div>',
        '<div class="bd">아직 연결을 시작하지 않았습니다. 취소한 뒤 환불을 요청할 수 있습니다.</div><div class="f"><button class="b pri neg" type="button">그만두기</button><button class="b " type="button">취소</button></div>')
t = rep(t, '<div class="bd">진행을 멈추고 지금까지 바꾼 설정(앱 설치 · 웹훅 · 방송 화면 소스)을 되돌립니다. 연결을 시작한 뒤라 환불되지 않습니다 · 결제 전에 동의하신 내용입니다.</div><div class="f"><button class="b pri neg" type="button">취소하고 되돌리기</button><button class="b " type="button">계속 진행</button></div>',
        '<div class="bd">진행을 멈추고 지금까지 바꾼 설정을 되돌립니다. 설정을 시작한 뒤라 환불되지 않습니다 · 결제 전에 동의하신 내용입니다.</div><div class="f"><button class="b pri neg" type="button">그만두기</button><button class="b " type="button">취소</button></div>')
# 취소 완료: 구현 끝 카드 + 「되돌리는 중」 상태 추가 · 되돌린 항목 목록은 구현 미확인
t = rep(t, '<div class="toast2">자동 연결을 취소하고 설정을 되돌렸습니다<a href="#">홈으로</a></div><span class="hint">되돌린 것: 웹훅 2개 삭제 · 방송 화면 소스 제거 · 앱 설치는 쇼핑몰 관리자에서 직접 삭제할 수 있습니다</span>',
        '<div class="note cau" style="width: 100%"><b>바꾼 설정을 원래대로 되돌리고 있습니다.</b> 끝나면 알려 드립니다</div><div class="box" style="width: 100%; padding: 12px"><b>자동 연결을 취소했습니다</b><div class="nt" style="margin-top: 4px">시작 뒤 취소: 설정을 시작한 뒤라 환불되지 않습니다 · 결제 전에 동의하신 내용입니다 / 시작 전 취소: ' + REFUND + '</div><div style="margin-top: 8px">' + END_BTNS + '</div></div><span class="hint">되돌린 항목 목록(웹훅 · 방송 화면 소스 · 앱 설치) 표시 ' + UNV + '</span>')
# 대기 중: 구현 상태 이름 · 문구 · 멈추기 가능
t = rep(t, '<div class="note inf" style="width: 100%"><b>순서를 기다리고 있습니다</b> · 앞에 3개 · 약 10분 뒤 시작합니다 · 창을 닫아도 알림으로 알려 드립니다</div>',
        '<span class="tag n">순서 기다리는 중</span><div class="note inf" style="width: 100%"><b>순서를 기다리고 있습니다</b> · 앞에 3개 · 약 10분 뒤 시작합니다 · 창을 닫아도 진행됩니다 · 결제가 확인되기 전에는 작업이 시작되지 않습니다</div><div class="row" style="gap: 8px"><button class="b sm" type="button">잠시 멈추기</button><button class="b sm" type="button">자동 설정 그만두기</button></div><span class="hint">잠시 멈추기는 순서 기다리는 중 · 설정하는 중 · 확인하는 중에만(서버) · 버튼 화면 표시 <span class="nt">(#1007 소스 반영 · 실화면 동작 미검증)</span>' + '</span>')
t = rep(t, '<span class="tag bl">실행 중</span><table class="lt">', '<span class="tag live">설정하는 중</span><table class="lt">')
t = rep(t, '<span class="tag bl">검증 중</span><div class="note inf" style="width: 100%"><b>테스트 주문 이벤트를 보냈습니다</b> · 방송 화면에 「테스트 주문」이 보이는지 확인하고 있습니다 · 최대 2분</div>',
        '<span class="tag live">확인하는 중</span><div class="note inf" style="width: 100%"><b>테스트 주문 이벤트를 보냈습니다</b> · OBS 오버레이에 「테스트 주문」이 보이는지 확인하고 있습니다</div>')
# 완료: 구현은 완료 화면(SA-153)으로 이동
t = rep(t, '<div class="toast2">자동 연결이 끝났습니다 · 실제 표시까지 확인했습니다<a href="#">완료 설정 확인</a></div><span class="hint">21:31 완료 · 걸린 시간 26분(고객 확인 대기 14분 포함)</span>',
        '<div class="note pos" style="width: 100%"><b>완료</b> · 상태가 완료가 되면 자동 연결 완료 화면(SA-153)으로 바로 이동합니다</div><span class="hint">21:31 완료 · 걸린 시간 26분(고객 확인 대기 14분 포함) ' + UNV + '</span>')
# 실패: 구현 ERROR_TEXT 중 하나 · 끝 카드 버튼 · 재시도 비용 문구는 구현 미확인
t = rep(t, '<div class="note neg" style="width: 100%"><b>외부 쇼핑몰 웹훅 등록에 실패했습니다.</b> 원인: 관리자 계정에 앱 설치 권한이 없습니다 · 권한을 받은 뒤 다시 시도해 주십시오</div><button class="b sm pri" type="button">다시 시도</button><button class="b sm" type="button">직접 설정하러 가기</button><span class="hint">다시 시도에 추가 비용이 없습니다 · 테스트 주문이 표시되지 않으면 전액 환불해 드립니다</span>',
        '<span class="tag r">실패</span><div class="note neg" style="width: 100%"><b>자동 연결을 끝내지 못했습니다. 「자동 연결 다시 하기」를 누르거나 직접 설정을 이용해 주십시오</b> · ' + REFUND + '</div>' + END_BTNS + '<span class="hint">실패 사유는 서버 코드별 문구(결제되지 않음 · 24시간 미확인 · 비용 한도 · 접수 한도 · 테스트 미확인 · 처리 시간 초과 · 시작 · 전체 기한 · 방송용 컴퓨터 사용 중) · 「다시 시도」 버튼과 무료 재시도 ' + UNV + '</span>')
t = rep(t, '<div class="note neg" style="width: 100%"><b>테스트 주문이 방송 화면에 나오지 않았습니다.</b> 지원으로도 해결되지 않아 결제한 금액(N원)을 전액 환불해 드립니다 · 결제한 카드로 카드사 기준 3~5영업일 · 직접 설정은 무료로 계속 할 수 있습니다</div><button class="b sm pri" type="button">직접 설정하러 가기</button>',
        '<div class="note neg" style="width: 100%"><b>테스트 주문이 방송 화면에 나오는지 확인하지 못했습니다. 「자동 연결 다시 하기」를 누르거나 직접 설정을 이용해 주십시오</b> · ' + REFUND + '</div>' + END_BTNS)
# 중단 · 이어 하기: 서버 pause · continue 규칙
t = rep(t, '<div class="note inf" style="width: 100%"><b>잠시 멈춰 두었습니다.</b> 2026.10.02 21:20 · 3단계(방송 화면 넣기)에서 멈췄습니다 · 이어 하면 멈춘 단계부터 다시 시작합니다</div><button class="b sm pri" type="button">이어 하기</button><button class="b sm" type="button">자동 설정 그만두기</button>',
        '<span class="tag n">순서 기다리는 중</span><div class="note inf" style="width: 100%"><b>잠시 멈춰 두었습니다.</b> 2026.10.02 21:20 · 4단계(방송 프로그램에 방송 화면 넣기)에서 멈췄습니다 · 이어 하면 멈춘 단계부터 다시 시작합니다 · 시작 · 전체 기한은 멈춰 있어도 흐릅니다</div><button class="b sm pri" type="button">이어 하기</button><button class="b sm" type="button">자동 설정 그만두기</button><span class="hint">멈추기는 순서 기다리는 중 · 설정하는 중 · 확인하는 중에만 · 직접 해 주셔야 하는 동안과 끝난 작업은 멈출 수 없습니다 · 이미 멈춘 작업을 다시 멈추거나 멈추지 않은 작업을 이어 하면 처리하지 않습니다</span>')
# 결제 확인 중 상태 추가(구현 AWAITING_PAYMENT · 결제창 복귀 띠)
t = rep(t, '<div class="st"><span class="st-tag">대기 중</span>',
        '<div class="st"><span class="st-tag">결제 확인 중 · 결제창에서 돌아옴</span><div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start"><span class="tag n">결제 확인 중</span><div class="note pos" style="width: 100%"><b>결제됐습니다</b> · 자동 연결을 시작합니다</div><div class="note inf" style="width: 100%"><b>결제를 확인하고 있습니다</b> · 카드사 승인 뒤 서버가 한 번 더 확인합니다 · 창을 닫아도 진행됩니다 · 결제가 확인되기 전에는 작업이 시작되지 않습니다</div></div></div><div class="st"><span class="st-tag">대기 중</span>')
t = rep(t, '대기 중 · 14분', '대기 중 · 14분 <span class="nt">(경과 분은 서버에 없음 · 구현 미확인 2026-10-16)</span>')
t = rep(t, '"height":1250', '"height":3800')
p.write_text(t, encoding='utf-8'); print('wrote SA-152.dc.html', len(t))
