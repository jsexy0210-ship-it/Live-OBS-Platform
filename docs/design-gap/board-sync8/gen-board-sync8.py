#!/usr/bin/env python3
"""보드 반영 묶음 8 — 「구조가 정본과 다른 화면」 판정(MASTER 배정 · 정정 2026-10-06) 중 근거가 명확한 항목만 보드에 반영한다.
규칙(MASTER 정정): 정본 요소 삭제는 문서에 기록된 대표님 결정과 어긋나거나 서버 모델이 의도적으로 다르게 확정된 경우에만. 근거 없는 차이는 ①(구현 · 서버 추가)로 두고 docs/UI_STATUS.md 에 「서버 필요」로 적는다.
① MA-084: 답변 모델 「[대표님 확정 전]」 → AI 종류 · 질문/답변 단가 · 월 한도 10,000원(CLAUDE.md 2026-10-05 「도우미는 월 1만 원 한도로 시작」) · 연결 키 설정 여부 · 이번 달 사용(서버 AssistantSetting · usage)
② MA-021: 요금제 카드의 「제공량 추후 안내」 → 체험 한도(알림톡 · 본인확인 · 저장, 결정 2026-10-02) · 월 무료 메일(결정 2026-10-05 · plan.mailMonthlyQuota)
③ SA-068: 간편 가입 · 가입 쿠폰 삭제(MASTER 2026-10-06 명시) · 탈퇴 즉시 문구를 「결제 완료 · 미배송 주문 있으면 탈퇴 보류」(PRODUCT_SCOPE:50)로
④ SA-090: 제공량 「추후 안내 · 방송 시간 · 저장 용량」 → 「월 무료 메일 N통」(CLAUDE.md 2026-10-05 플랜별 월 제공량)
⑤ SH-025-IA: 광고성 행(방송 시작 · 할인 · 재입고 · 혜택)의 알림톡 · 문자 열 → 메일만(PRODUCT_SCOPE:60 「광고성 메시지는 알림톡으로 보내지 않는다」)
⑥ SH-029-IA: 사진 3장 → 5장(서버 REVIEW_IMAGES_PER_REVIEW=5) · 내 리뷰 표에 상태(공개 · 확인 중 · 숨김) · 판매자 답글 · 고치기(7일) · 지우기(서버 있음)
⑦ SA-130: 서버에 있는 알림 종류 행 추가(입금 확인 · 결제 완료 · 반품 · 교환 요청, lib/server/notifications/service.ts)
사용: gen-board-sync8.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리> [높이 json]"""
import sys, re, pathlib, json, math
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))

# ① MA-084
s = rd('MA-084.dc.html')
s = rep(s, '<tr><th>답변 모델</th><td>[대표님 확정 전] <span class="hint">저장소 비밀값 이름으로만 연결합니다 · 값은 여기서 보이지 않습니다</span></td></tr><tr><th>월 비용 한도</th><td><input class="i w-xs" type="text" value="0" placeholder=""><span class="unit">원</span><span class="hint">넘으면 자동으로 쉽니다</span></td></tr>',
        '<tr><th>도우미 연결 키</th><td><span class="tag g">설정됨</span> <span class="hint">값은 환경 설정에만 있고 여기서 보이지 않습니다 · 없으면 파트너스 화면에 「준비 중」으로 보입니다</span></td></tr>'
        '<tr><th>AI 종류</th><td><input class="i w-l" type="text" value="gemini-2.5-flash-lite" placeholder="예: gemini-2.5-flash-lite"><span class="hint">모델 이름과 단가는 공식 문서를 확인해 입력합니다 · 단가는 100만 글자당 원 (예: 입력 $0.10 · 출력 $0.40 → 1,450원/$ 환산 입력 145원 · 출력 580원)</span></td></tr>'
        '<tr><th>질문 글자 비용</th><td><input class="i w-xs" type="text" value="145" placeholder="예: 145"><span class="unit">원 · 100만 글자당</span></td></tr>'
        '<tr><th>답변 글자 비용</th><td><input class="i w-xs" type="text" value="580" placeholder="예: 580"><span class="unit">원 · 100만 글자당</span></td></tr>'
        '<tr><th>월 비용 한도</th><td><input class="i w-xs" type="text" value="10,000" placeholder=""><span class="unit">원 · 전체 합계</span><span class="hint">넘으면 도우미 호출이 바로 멈춥니다 · 대표님 결정 2026-10-05: 월 1만 원 한도로 시작하고 나중에 늘립니다 · 한도 상향은 대표님 승인 뒤</span></td></tr>')
s = rep(s, '<tr><th>이번 달 사용</th><td>— (연결 전)</td></tr>', '<tr><th>이번 달 사용</th><td><b>3,120원</b> / 10,000원 · 답변 212건 · 답하지 못함 14건 · 실패 2건</td></tr>')
s = rep(s, '답변 모델 · 비용은 대표님 확정 전입니다 · 아래 모델 칸은 자리만 둡니다', 'AI 종류 · 단가 · 월 한도는 최고관리자만 바꿉니다 · 변경은 로그 추적에 남습니다')
assert '대표님 확정 전' not in s
wr('MA-084.dc.html', s)

# ② MA-021
s = rd('MA-021.dc.html')
s = rep(s, '<tr><th>제공량</th><td><span class="tag n">추후 안내</span> 방송 시간 · 알림 건수 · 직원 수 · 저장 용량 · 미정</td></tr>',
        '<tr><th>월 무료 메일</th><td>주문 · 배송 안내 메일 2,000통<div class="nt">2026.11.01부터 3,000통 (적용 예정)</div></td></tr><tr><th>체험 한도</th><td>— (체험 없음)</td></tr>')
s = rep(s, '<tr><th>제공량</th><td><span class="tag n">추후 안내</span></td></tr>',
        '<tr><th>월 무료 메일</th><td>주문 · 배송 안내 메일 500통</td></tr><tr><th>체험 한도</th><td>알림톡 · 문자 100건 · 휴대폰 본인확인 20건 · 저장 용량 500MB</td></tr>')
m = re.search(r'<tr>(?:(?!</tr>).)*2026\.10\.02 11:05(?:(?!</tr>).)*</tr>', s); assert m and '추후 안내' in m.group(0)
s = s.replace(m.group(0), '<tr><td>2026.10.02 11:05</td><td>쇼핑몰 통합</td><td>월 무료 메일 수량</td><td>2,000통 → 3,000통 (2026.11.01 적용 예정)</td><td>대표</td><td>불필요</td></tr>')
assert '추후 안내' not in s
wr('MA-021.dc.html', s)

# ③ SA-068
s = rd('SA-068.dc.html')
s = rep(s, '<tr><th>탈퇴 즉시</th><td>로그인 차단 · 적립금 · 쿠폰 소멸 · 진행 중 주문은 끝까지 처리</td></tr>',
        '<tr><th>탈퇴 즉시</th><td>로그인 차단 · 적립금 · 쿠폰 소멸 · 결제 대기 주문은 취소<span class="hint">결제를 마쳤는데 배송이 끝나지 않은 주문이 있으면 탈퇴가 보류됩니다 · 배송이 끝난 뒤 다시 신청</span></td></tr>')
s = rep(s, '<tr><th>가입 방식</th><td><label class="ck"><input type="checkbox" name="r" checked>이메일 가입</label><label class="ck"><input type="checkbox" name="r">카카오 간편 가입</label><label class="ck"><input type="checkbox" name="r">네이버 간편 가입</label><span class="hint">간편 가입은 연동 뒤 제공</span></td></tr><tr><th>가입 축하</th><td><label class="ck"><input type="checkbox" name="r" checked>가입 쿠폰 자동 지급 (쿠폰 관리에서 설정)</label></td></tr>', '')
for bad in ['간편 가입', '가입 쿠폰']: assert bad not in s, bad
wr('SA-068.dc.html', s)

# ④ SA-090
s = rd('SA-090.dc.html')
s = rep(s, '<tr><th>제공량</th><td class=rt><span class="tag n">추후 안내</span> 방송 시간 · 저장 용량 등 · 거래 메일 월 [확정 전]통 (넘는 발송 · 알림톡 · 문자는 발송·이용 충전 잔액에서 차감)</td>',
        '<tr><th>월 무료 메일</th><td class=rt>주문 · 배송 안내 메일 월 2,000통 (넘는 발송 · 알림톡 · 문자는 발송·이용 충전 잔액에서 차감)</td>')
assert '추후 안내' not in s
wr('SA-090.dc.html', s)

# ⑤ SH-025-IA (PC · 휴대폰 두 번)
s = rd('SH-025-IA.dc.html')
for name, hint in [('방송 시작', '판매자가 방송을 시작하면'), ('할인 · 재입고', '찜한 상품의 할인 · 재입고 소식'), ('혜택 · 이벤트 (선택)', '쿠폰 · 등급 · 이벤트 안내')]:
    pat = re.compile(r'(<td class="l"><b>' + re.escape(name) + r'</b><div class="hint" style="margin: 0">' + re.escape(hint) + r'</div></td>)<td><label class="ck"><input type="checkbox" name="r"( checked)?></label></td>')
    assert len(pat.findall(s)) == 2, (name, len(pat.findall(s)))
    s = pat.sub(r'\1<td><span class="hint" style="margin: 0">— (메일만)</span></td>', s)
s = rep(s, '앱 알림(푸시)은 없어요 · 알림톡이 안 되면 문자로 보내요 · <span style="white-space: nowrap">야간(21~08시)에는</span> 혜택 알림을 보내지 않아요',
        '앱 알림(푸시)은 없어요 · 알림톡이 안 되면 문자로 보내요 · 방송 시작 · 할인 · 혜택 같은 광고성 소식은 메일로만 보내요 · <span style="white-space: nowrap">야간(21~08시)에는</span> 보내지 않아요', 2)
wr('SH-025-IA.dc.html', s)

# ⑥ SH-029-IA (PC · 휴대폰 두 번)
s = rd('SH-029-IA.dc.html')
s = rep(s, '<span class="th" style="width: 72px; height: 72px; border-style: dashed">3</span></div><span class="hint">최대 3장 · JPG · PNG · WEBP · 장당 5MB</span>',
        '<span class="th" style="width: 72px; height: 72px; border-style: dashed">3</span><span class="th" style="width: 72px; height: 72px; border-style: dashed">4</span><span class="th" style="width: 72px; height: 72px; border-style: dashed">5</span></div><span class="hint">최대 5장 · JPG · PNG · WEBP · 장당 5MB · 연락처 · 외부 링크는 적을 수 없어요</span>', 2)
s = rep(s, '<colgroup><col><col style="width: 90px"><col style="width: 80px"><col style="width: 90px"></colgroup><thead><tr><th class="l">상품 · 내용</th><th>별점</th><th>날짜</th><th>관리</th></tr></thead>',
        '<colgroup><col><col style="width: 90px"><col style="width: 70px"><col style="width: 70px"><col style="width: 130px"></colgroup><thead><tr><th class="l">상품 · 내용</th><th>별점</th><th>상태</th><th>날짜</th><th>관리</th></tr></thead>', 2)
s = rep(s, '<td class="l"><b>스타라이트 부스터 박스</b><div class="hint" style="margin: 0">홀로 두 장 나왔어요! 포장도 꼼꼼했어요.</div></td><td style="color: #f5a623">★★★★★</td><td>9/27</td><td><button class="btn s" type="button">수정</button></td>',
        '<td class="l"><b>스타라이트 부스터 박스</b><div class="hint" style="margin: 0">홀로 두 장 나왔어요! 포장도 꼼꼼했어요.</div><div class="hint" style="margin: 0">↳ 판매자 답글 · 즐거운 개봉이었어요, 감사합니다!</div></td><td style="color: #f5a623">★★★★★</td><td><span class="t">공개</span></td><td>9/27</td><td><button class="btn s" type="button">고치기</button> <button class="btn s" type="button">지우기</button></td>', 2)
s = rep(s, '<td class="l"><b>카드 슬리브 100매</b><div class="hint" style="margin: 0">두께 적당하고 투명해요.</div></td><td style="color: #f5a623">★★★★☆</td><td>9/15</td><td><button class="btn s" type="button">수정</button></td>',
        '<td class="l"><b>카드 슬리브 100매</b><div class="hint" style="margin: 0">두께 적당하고 투명해요.</div></td><td style="color: #f5a623">★★★★☆</td><td><span class="t">확인 중</span></td><td>9/15</td><td><span class="hint" style="margin: 0">7일 지남 · 지우기만</span></td>', 2)
s = rep(s, '<div class="st"><span class="st-tag">삭제 확인</span>', '<div class="st"><span class="st-tag">숨김 · 사유 표시</span><div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start"><div class="sh24" style="width: 100%; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; background: transparent"><div class="msg cau">이 리뷰는 숨겨졌어요 · 사유: 연락처가 적혀 있어요 · 고치면 다시 확인해요</div></div></div></div><div class="st"><span class="st-tag">삭제 확인</span>')
s = rep(s, '리뷰를 쓰면 적립금 500원 (사진 리뷰 1,000원) · 배송 완료 30일 안', '리뷰를 쓰면 적립금 500원 (사진 리뷰 1,000원) · 배송 완료 30일 안 · 등록 뒤 7일 안에 고칠 수 있어요', 2)
assert '최대 3장' not in s
wr('SH-029-IA.dc.html', s)

# ⑦ SA-130 서버 알림 종류 행 추가
s = rd('SA-130.dc.html')
row = lambda tag, cls, t, sub: f'<div style="padding: 8px 12px; border-bottom: 1px solid var(--c24-line2)"><span class="tag {cls}">{tag}</span> <b>{t}</b><div class="nt">{sub}</div></div>'
s = rep(s, '<div class="nt" style="padding: 4px 12px; background: var(--c24-th)">이전</div>',
        row('입금', 'y', '밤하늘님 주문 · 입금 확인이 필요합니다', '12:10 · 12,000원 · 무통장 · 입금자명 밤하늘') + row('결제', 'g', '레인보우님 주문 결제 완료 · 89,100원', '11:58 · 카드') + row('반품', 'y', '카드왕님이 반품을 요청했습니다', '11:05 · 스타라이트 부스터 박스 · 사유 「파손」') + '<div class="nt" style="padding: 4px 12px; background: var(--c24-th)">이전</div>')
s = rep(s, '새 공지(최근 14일), 문의 답변, 입금 확인 요청, 결제 완료, 품절, 반품·교환 요청이 보입니다.', '새 공지(최근 14일), 문의 답변, 입금 확인 요청, 결제 완료, 품절, 반품 · 교환 요청, 충전금 부족이 보입니다.')
wr('SA-130.dc.html', s)

c = json.loads(rd('canvas.json'))
for k, h in (json.loads(pathlib.Path(sys.argv[3]).read_text()).items() if len(sys.argv) > 3 else []):
    want = math.ceil((h + 20) / 10) * 10
    if c['boards'][k]['h'] < want: print('height', k, c['boards'][k]['h'], '->', want); c['boards'][k]['h'] = want
wr('canvas.json', json.dumps(c, ensure_ascii=False, indent=2) + '\n')
print('done')
