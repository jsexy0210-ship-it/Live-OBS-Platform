#!/usr/bin/env python3
"""SA-023 취소·환불 요청 목록 정본 — 구현 app/(seller)/seller/(shell)/orders/refund-requests/page.tsx 기준으로 보드 재작성."""
import re
P = '/home/user/Live-OBS-Platform/design/project/SA-023.dc.html'
s = open(P).read()
ARROW = ''  # 메뉴 화면(탭) → ← 없음
i = s.find('<main class="cont">'); j = s.find('</main>', i) + len('</main>')
old_main = s[i:j]
k = s.find('<div class="cfm"', j); st = s.find('<div class="states">')
old_cfm = s[k:st]            # 주문 상세에서 여는 취소 · 환불 창(기존)
old_states_inner = s[st + len('<div class="states">'):]
old_states_inner = old_states_inner.replace('<span class="states-h">상태 변형</span>', '<span class="states-h">주문 상세에서 여는 취소 · 환불 창(SA-022 「취소 · 환불」) 상태</span>', 1)

def row(no, goods, when, ago, buyer, grade, amt, reason, tag, tagcls, act):
    return (f'<tr><td class="l"><a href="SA-022.dc.html"><b>{no}</b></a><span class="sub">{goods}</span></td>'
            '<td class="l">' + when + ('<span class="ago hot">' + ago + '</span>' if ago else '') + '</td>'
            f'<td class="l">{buyer}<span class="sub">{grade}</span></td><td class="num r">{amt}</td><td class="l">{reason}</td>'
            f'<td><span class="tag {tagcls}">{tag}</span></td><td><div class="acts2">{act}</div></td></tr>')

TH = '<thead><tr><th class="l" style="width: 260px">주문</th><th class="l" style="width: 140px">요청 시각</th><th class="l" style="width: 120px">구매자</th><th class="num" style="width: 110px">금액</th><th class="l">사유</th><th style="width: 100px">상태</th><th style="width: 120px">관리</th></tr></thead>'
B_PROC = '<button class="b sm pri" type="button">처리</button>'
B_VIEW = '<button class="b sm" type="button">보기</button>'
rows_wait = ''.join([
    row('20261002-0418', '선라이트 스타터 덱 ×1', '10/2 18:40', '1일째 기다리는 중', '탈퇴 회원', '—', '24,000원', '단순 변심 · 미개봉', '처리 대기', 'y', B_PROC),
    row('20261002-0415', '홀로그램 피닉스 풀아트 ×1 외 1', '10/2 16:05', '', '밤하늘', '골드', '45,000원', '잘못 주문 · 일부 상품', '처리 대기', 'y', B_PROC),
    row('20261002-0411', '부스터 팩 151 ×3', '10/2 14:22', '', '카드수집가', '실버', '18,000원', '품절 안내 받음', '처리 대기', 'y', B_PROC),
])
new_main = ('<main class="cont"><div class="pathbar">주문 › 취소 · 교환 · 반품</div><div class="ph2"><h1>취소 · 환불 요청</h1><span class="path">주문 › 취소 · 교환 · 반품</span><div class="acts"><a class="b " href="SA-021.dc.html">전체 주문</a></div></div>'
            '<div class="rtabs"><a class="on" href="SA-023.dc.html">취소 · 환불</a><a class="" href="SA-029.dc.html">교환 · 반품</a></div>'
            '<span class="nt">발송 전 주문에서 구매자가 보낸 환불 요청입니다. 승인하면 요청한 상품으로 바로 환불되고, 거절하면 사유가 구매자에게 보입니다. 발송 뒤 요청은 「교환 · 반품」 탭에서 처리합니다.</span>'
            '<div class="chips"><button class="chip on hot" type="button">처리 대기 <span class="n">3</span></button><button class="chip" type="button">승인 <span class="n">12</span></button><button class="chip" type="button">거절 <span class="n">2</span></button><button class="chip" type="button">철회 <span class="n">1</span></button><span class="nt" style="margin-left:8px">탭은 주소(?status=)에 남아 Back · 새로고침에도 유지</span></div>'
            '<div class="lpanel"><div class="ltop"><b>처리 대기 3건</b><span class="nt">요청 시각 오래된 순</span></div><table class="lt">' + TH + '<tbody>' + rows_wait + '</tbody></table>'
            '<div class="row" style="justify-content:center;padding:12px 0 4px"><button class="b" type="button">더 보기</button></div></div>'
            '<span class="hint">「처리」는 주문 · 배송 권한이 있을 때만 보이고, 권한이 없으면 「보기」로 바뀝니다 · 처리한 행만 목록에서 빠지고 불러온 쪽수 · 스크롤은 그대로 둡니다</span></main>')

ITEMS = '<table class="lt"><thead><tr><th class="l">환불 상품</th><th style="width:80px">수량</th><th class="num" style="width:110px">금액</th></tr></thead><tbody><tr><td class="l">선라이트 스타터 덱</td><td>1</td><td class="num r">24,000원</td></tr></tbody></table>'
FAULT = ('<div class="row" style="gap:16px"><label class="ck"><input type="radio" name="fa" checked> 구매자 사정 <span class="nt">변심 · 잘못 주문</span></label><label class="ck"><input type="radio" name="fa"> 파트너스 사정 <span class="nt">품절 · 오류</span></label></div>'
         '<span class="hint">구매자 사정만 결제 후 취소 횟수에 포함됩니다 · 선택하지 않으면 환불할 수 없습니다</span>')
def cfm(title_extra, body, foot, width=720):
    return (f'<div class="cfm" style="width: {width}px"><div class="h">환불 요청 처리 <span class="nt" style="font-weight: 400">{title_extra}</span><button class="x" type="button" aria-label="닫기">×</button></div>'
            f'<div class="bd">{body}</div><div class="f">{foot}</div></div>')
SUM = '<div class="sum"><div><div class="k">주문</div><div class="v">20261002-0418</div></div><div><div class="k">요청 시각</div><div class="v">2026.10.02 18:40</div></div><div><div class="k">사유</div><div class="v">단순 변심</div></div><div><div class="k">상태</div><div class="v"><span class="tag y">처리 대기</span></div></div></div>'
body_main = (SUM + '<table class="ft"><colgroup><col style="width: 150px"><col></colgroup>'
             '<tr><th>상세 사유</th><td class="l">포장을 뜯지 않았습니다. 다른 상품으로 다시 주문하겠습니다.</td></tr>'
             '<tr><th>환불 상품</th><td>' + ITEMS + '</td></tr>'
             '<tr><th>사유 주체 <span class="rq">*</span></th><td>' + FAULT + '</td></tr>'
             '<tr><th>환불 미리보기</th><td><b>24,000원</b> 카드 승인 취소 <span class="nt">· 반품 배송비 0원 차감(발송 전) · 적립금 사용 0원 복구</span></td></tr>'
             '<tr><th>확인</th><td><label class="ck"><input type="checkbox" checked> 요청한 상품으로 환불하는 것을 확인했습니다</label></td></tr></table>')
foot_main = '<button class="b" type="button">취소</button><button class="b" type="button">거절</button><button class="b pri" type="button">승인하고 환불</button>'
new_cfm = cfm('주문 20261002-0418 · 탈퇴 회원', body_main, foot_main)

def st(tag, inner):
    return f'<div class="st"><span class="st-tag">{tag}</span><div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start">{inner}</div></div>'
new_states = ''.join([
    st('거절 사유 입력', '<table class="ft" style="width:100%"><colgroup><col style="width: 120px"><col></colgroup><tr><th>거절 사유 <span class="rq">*</span></th><td><textarea class="i" style="width:100%;height:88px" placeholder="구매자에게 보이는 사유를 적어 주십시오"></textarea><span class="hint">구매자에게 보입니다 · 0/200자</span></td></tr></table><div class="row" style="gap:8px"><button class="b" type="button">돌아가기</button><button class="b neg pri" type="button" disabled>거절 처리</button></div>'),
    st('승인 완료 토스트', '<div class="toast2">환불을 승인했습니다 · 24,000원 카드 취소를 요청했습니다</div><span class="hint">처리한 행은 목록에서 빠지고 「승인」 탭 건수가 하나 늘어납니다</span>'),
    st('미리보기 오류 · 승인 불가', '<div class="box" style="padding:12px 16px;border-color:#e3a7a9;background:#fdecec;color:#c0262c;font-size:13px;line-height:20px">요청한 뒤 주문 화면에서 이미 환불한 상품이 있어 승인할 수 없습니다. 거절해 주십시오.</div><span class="hint">같은 자리 문구 2종: 「개봉 대기 중인 상품이 있어 일부만 환불할 수 없습니다. 거절하거나 주문 화면에서 처리해 주십시오.」 · 「개봉한 상품을 보내지 않아 환불할 수 없습니다. 거절하거나 주문 화면에서 처리해 주십시오.」 · 승인 버튼은 꺼짐</span>'),
    st('사유 주체로 환불 불가', '<span style="color:#c0262c;font-size:13px">이 사유 주체로는 환불할 수 없는 주문입니다</span><span class="hint">미리보기 blocked · 다른 사유 주체를 고르거나 거절</span>'),
    st('보기 창 · 승인된 요청', '<table class="ft" style="width:100%"><colgroup><col style="width: 120px"><col></colgroup><tr><th>상태</th><td><span class="tag g">승인</span></td></tr><tr><th>처리 시각</th><td>2026.10.02 19:10 · 대표</td></tr><tr><th>환불</th><td>24,000원 · 카드 취소 완료</td></tr></table><div class="row"><button class="b" type="button">닫기</button></div>'),
    st('보기 창 · 거절된 요청', '<table class="ft" style="width:100%"><colgroup><col style="width: 120px"><col></colgroup><tr><th>상태</th><td><span class="tag n">거절</span></td></tr><tr><th>거절 사유</th><td class="l">개봉 대기 중인 상품이라 환불할 수 없습니다. 방송이 끝난 뒤 다시 요청해 주십시오.</td></tr><tr><th>처리 시각</th><td>2026.10.02 15:02 · 김직원</td></tr></table>'),
    st('보기 창 · 철회된 요청', '<table class="ft" style="width:100%"><colgroup><col style="width: 120px"><col></colgroup><tr><th>상태</th><td><span class="tag n">철회</span></td></tr><tr><th>철회 시각</th><td>2026.10.02 14:50 · 구매자</td></tr></table>'),
    st('빈 목록', '<div class="box" style="padding:32px;text-align:center;width:100%;color:#6b7280">처리할 환불 요청이 없습니다</div>'),
    st('권한 없음 · 잠김', '<div class="box" style="padding:16px;width:100%">주문 · 배송 권한이 필요합니다 <span class="nt">· 대표에게 요청해 주십시오</span></div><span class="hint">402(요금제에 없음)는 공통 잠김 화면</span>'),
    st('로딩 · 오류', '<div class="sk" style="height:44px;width:100%"></div><div class="sk" style="height:44px;width:100%"></div><div class="box" style="padding:12px 16px;width:100%">환불 요청을 불러오지 못했습니다 <button class="b sm" type="button" style="margin-left:8px">다시 시도</button></div>'),
])
new = s[:i] + new_main + '\n' + new_cfm + '\n<div class="states"><span class="states-h">상태 변형</span>' + new_states + '</div>\n<div class="states">' + old_states_inner.replace('</x-dc>', '', 1)
# old_states_inner 끝에 </x-dc> 이하가 포함돼 있음 → 다시 붙임
tail = s[s.find('</x-dc>'):]
old_cfm_clean = old_cfm.rstrip()
assert old_cfm_clean.endswith('</div></div></div>')
old_cfm_clean = old_cfm_clean[:-len('</div></div>')]  # ovl · wrap 닫는 태그 제거(cfm 닫는 태그는 남김)
old_variant = '<div class="st" style="grid-column:1/-1"><span class="st-tag">주문 상세(SA-022)에서 여는 취소 · 환불 창</span>' + old_cfm_clean.replace('<div class="cfm" style="width: 1040px">', '<div class="cfm" style="width: 1040px; max-width: 1040px; margin: 0">', 1) + '</div>'
new = s[:i] + new_main + '<div class="ovl">' + new_cfm + '</div></div>\n<div class="states"><span class="states-h">상태 변형</span>' + new_states + old_states_inner[:old_states_inner.find('</x-dc>')].rstrip()
assert new.endswith('</div>')
new = new[:-len('</div>')] + old_variant + '</div>\n' + tail
new = new.replace('<title>취소 · 환불 처리</title>', '<title>취소 · 환불 요청</title>')
new = re.sub(r'"\$preview":\{"width":1440,"height":\d+\}', '"$preview":{"width":1440,"height":3600}', new)
open(P, 'w').write(new)
print(len(s), '->', len(new))
