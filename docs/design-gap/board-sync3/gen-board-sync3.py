#!/usr/bin/env python3
"""보드 반영 묶음 3 (디자인 전담 (6), MASTER 배정 2026-10-06):
DS-TABLE-CARD 2×2 예외 · SA-031 회수 방식 · 유효 기간(3년 소멸) · SH-022-IA 현금영수증 · 세금계산서 신청(서버 /receipt-requests) ·
SA-001 파트너스 공통 띠(체험 · 결제 실패 · 이용 종료) · SH-001-IA · SH-001-PC-IA 상단 공지 한 줄 · 카카오톡 문의 · 유튜브 링크 ·
SH-030 · SH-030-PC 이용안내(서버 글 그대로) · lop.css(topn · sns · kakao · ylink).
사용: gen-board-sync3.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리> (입력은 캔버스 아티팩트 사본)"""
import sys, re, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))
COL = '<div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start">'
SH = '<div class="sh24" style="width: 100%; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; background: transparent">'
def st(tag, body): return f'<div class="st"><span class="st-tag">{tag}</span>{COL}{SH}{body}</div></div></div>'
END = '\n</div>\n</div>\n</x-dc>'

# ── SA-031: 「마이너스 허용」 삭제(잔액 음수 금지, 서버 RevokeMode AUTO · MANUAL) · 유효 기간은 설정이 아니라 3년 고정 소멸 안내
s = rd('SA-031.dc.html')
s = rep(s, '<option>자동 회수 (마이너스 허용)</option>', '')
s = rep(s, '<th>유효 기간</th><td><select class="i w-m"><option selected>지급일로부터 12개월</option><option>6개월</option><option>무기한</option></select></td>',
        '<th>유효 기간</th><td>마지막 적립 후 3년이 지나면 소멸<span class="hint">새로 적립되지 않은 채 3년이 지나면 남은 적립금이 사라집니다 · 소멸 30일 전 회원에게 알림톡(안 되면 문자)으로 안내 · 기간은 바꿀 수 없습니다</span></td>')
s = rep(s, '자동 회수 (잔액 부족 시 실패로 기록)', '자동 회수 (잔액이 모자라면 실패로 기록)')
wr('SA-031.dc.html', s)

# ── DS-TABLE-CARD: 관리 버튼 예외(행동 4개 이하 · 생방송 운영 화면은 2×2) — SA-001 대기 표 모바일 카드(#822)와 일치
s = rd('DS-TABLE-CARD.dc.html')
s = rep(s, '행동이 1개면 1개 + 더보기, 0개면 더보기만(상세는 더보기 안 또는 카드 탭).</span></div>',
        '행동이 1개면 1개 + 더보기, 0개면 더보기만(상세는 더보기 안 또는 카드 탭). <b>예외</b> — 행동이 4개 이하이고 방송 중에 바로 눌러야 하는 생방송 운영 화면(SA-001 방송 대시보드 대기 표)은 더보기 없이 2×2 격자로 모두 노출(각 44px · 같은 폭 · 간격 8). 5개 이상이면 다시 주요 2개 + 더보기.</span></div>')
s = rep(s, '<div class="rule"><b>행동 없음</b>',
        '<div class="rule"><b>생방송 운영 2×2</b><span>SA-001 방송 대시보드의 대기 카드는 행동이 4개라 「타이머 정하기 · 주문대기에서 빼기」(위 줄) 「위로 · 아래로」(아래 줄)를 2×2로 모두 보입니다. 더보기 메뉴를 열 틈이 없는 생방송 운영 화면에만 쓰고, 목록 관리 화면은 주요 2개 + 더보기 그대로입니다.</span></div><div class="rule"><b>행동 없음</b>')
wr('DS-TABLE-CARD.dc.html', s)

# ── SH-022-IA: 현금영수증 · 세금계산서 신청 진입 · 입력 · 상태(서버 lib/server/receipts/service.ts · /api/shop/{slug}/receipt-requests)
s = rd('SH-022-IA.dc.html')
s = rep(s, '<div class="kv"><span class="k">현금영수증 · 세금계산서</span><span><span class="tag g">신청 안 함</span></span></div><span class="hint">카드 결제는 카드 매출전표로 대신해요</span>',
        '<div class="kv"><span class="k">현금영수증 · 세금계산서</span><span>카드 매출전표로 확인해요</span></div><span class="hint">무통장 · 계좌이체 주문만 신청할 수 있어요</span>', 2)
s = rep(s, '<span class="tag gr">배송 완료 · 10/6</span>', '<span class="tag gr">배송 완료 · 2026.10.06</span>')
s = rep(s, '10/12까지 입금하지 않으면 자동 취소돼요', '2026.10.12까지 입금하지 않으면 자동 취소돼요')
old_issued = '<div class="st"><span class="st-tag">현금영수증 발행 완료</span>'
i = s.find(old_issued); assert i > 0
j = s.find('</div></div></div>', i) + len('</div></div></div>')
KV = lambda v, hint: f'<div class="kv"><span class="k">현금영수증 · 세금계산서</span><span>{v}</span></div><span class="hint">{hint}</span>'
form = ('<div class="cfm" style="max-width: 400px"><div class="h">현금영수증 · 세금계산서 신청<span class="x">×</span></div><div class="bd" style="display: flex; flex-direction: column; gap: 8px">'
        '<b>발행 종류</b><label class="ck"><input type="radio" name="rk" checked>소득공제용 현금영수증</label><label class="ck"><input type="radio" name="rk">지출증빙용 현금영수증</label><label class="ck"><input type="radio" name="rk">세금계산서</label>'
        '<b style="margin-top: 4px">휴대폰 번호</b><input class="inp w-f" type="text" value="" placeholder="숫자만 적어 주세요" inputmode="numeric">'
        '<span class="hint" style="margin: 0">소득공제용은 휴대폰 번호, 지출증빙 · 세금계산서는 사업자등록번호를 적어요 · 번호는 안전하게 보관하고 화면에는 뒤 4자리만 보여요</span>'
        '<span class="hint" style="margin: 0">주문당 1건만 신청할 수 있어요 · 발행 전에는 철회할 수 있어요 · 입금 전 주문은 입금 확인 뒤 발행해요</span>'
        '</div><div class="f"><button class="btn" type="button">취소</button><button class="btn p" type="button">신청하기</button></div></div>')
tax = ('<div class="cfm" style="max-width: 400px"><div class="h">현금영수증 · 세금계산서 신청<span class="x">×</span></div><div class="bd" style="display: flex; flex-direction: column; gap: 8px">'
       '<b>발행 종류</b><label class="ck"><input type="radio" name="rk2">소득공제용 현금영수증</label><label class="ck"><input type="radio" name="rk2">지출증빙용 현금영수증</label><label class="ck"><input type="radio" name="rk2" checked>세금계산서</label>'
       '<b style="margin-top: 4px">사업자등록번호</b><input class="inp w-f" type="text" value="" placeholder="숫자 10자리" inputmode="numeric">'
       '<b style="margin-top: 4px">상호</b><input class="inp w-f" type="text" value="" placeholder="사업자등록증의 상호">'
       '<b style="margin-top: 4px">대표자</b><input class="inp w-f" type="text" value="" placeholder="대표자 이름">'
       '<b style="margin-top: 4px">세금계산서 받을 이메일</b><input class="inp w-f" type="email" value="" placeholder="example@email.com">'
       '</div><div class="f"><button class="btn" type="button">취소</button><button class="btn p" type="button">신청하기</button></div></div>')
new_states = ''.join([
    st('현금영수증 · 세금계산서 신청 (무통장 · 입금 전 · 결제 완료)', KV('<span class="tag g">신청 안 함</span> <button class="btn s" type="button">신청하기</button>', '무통장 · 계좌이체 주문만 · 주문당 1건 · 발행 전에는 철회할 수 있어요') + '<span class="hint">결제 정보 안의 줄에서 바로 신청해요 · 카드 주문은 「카드 매출전표로 확인해요」만 보이고 버튼이 없어요 · 「신청하기」를 누르면 PC는 가운데 창, 휴대폰은 아래 시트로 열려요</span>'),
    st('신청 창 · 소득공제용 (기본)', form),
    st('신청 창 · 세금계산서 (사업자 정보 추가)', tax),
    st('발행 대기', KV('<span class="tag y">발행 대기</span> 소득공제 · 휴대폰 끝 1234 <button class="btn s" type="button">철회</button>', '판매자가 발행하면 알려 드려요 · 입금 전 주문은 입금 확인 뒤 발행해요')),
    st('발행 보류', KV('<span class="tag y">발행 보류</span> 지출증빙 · 사업자번호 끝 1234 <button class="btn s" type="button">철회</button>', '판매자가 발행을 잠시 미뤘어요 · 발행되면 알려 드려요')),
    st('발행 실패', KV('<span class="tag r">발행 실패</span> 소득공제 · 휴대폰 끝 1234 <button class="btn s" type="button">철회</button>', '번호를 확인하고 철회한 뒤 다시 신청해 주세요')),
    st('발행 완료', KV('<span class="tag gr">발행 완료 · 2026.10.03</span> 소득공제 · 휴대폰 끝 1234', '입금 확인 뒤 발행했어요 · 발행된 신청은 철회할 수 없어요 · 바꾸려면 판매자에게 문의해 주세요')),
    st('철회함 · 다시 신청', KV('<span class="tag g">철회함</span> <button class="btn s" type="button">신청하기</button>', '철회한 신청은 취소로 남아요 · 다시 신청할 수 있어요')),
    st('신청 · 철회 오류', '<div class="msg neg">무통장 · 계좌이체 주문만 신청할 수 있어요. 카드는 카드 매출전표로 확인해 주세요</div><div class="msg neg">이미 신청한 주문이에요</div><div class="msg neg">번호를 다시 확인해 주세요</div><div class="msg neg">사업자 정보를 다시 확인해 주세요</div><div class="msg neg">지금은 신청할 수 없어요</div><div class="msg neg">이미 발행된 신청은 철회할 수 없어요. 판매자에게 문의해 주세요</div>'),
])
s = s[:i] + new_states + s[j:]
assert '10/3' not in s and '10/6' not in s and '10/12' not in s, re.findall(r'.{20}10/\d.{20}', s)
wr('SH-022-IA.dc.html', s)

# ── SA-001: 파트너스 공통 띠(체험 · 결제 실패 · 이용 종료) 정본 — 구현 SellerShell AccessBanner 자리(경로 줄 · 제목 아래, 탭 위)
s = rd('SA-001.dc.html')
band = lambda cls, b, t: f'<div class="note {cls}" style="margin: 16px 24px 0; display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: center"><b>{b}</b><span>{t}</span></div>'
frame = lambda inner: f'<div style="width: 100%; background: #fff; border: 1px solid var(--c24-line); padding-bottom: 16px"><div class="pathbar">방송 › 방송 대시보드</div>{inner}<div class="ph2" style="margin: 16px 0 0"><h1>방송 대시보드</h1><span class="path">방송 › 방송 대시보드</span></div></div>'
s = rep(s, END,
    '<div class="st"><span class="st-tag">공통 띠 · 체험 중 (모든 파트너스 화면)</span>' + COL + frame(band('inf', '체험이 14일 남았습니다', '체험이 끝나기 전에 구독하면 그대로 이어서 사용할 수 있습니다')) +
    '<span class="hint">자리: 경로 줄 바로 아래 · 화면 제목 위(구현 SellerShell 과 같은 자리) · 본문과 같은 좌우 여백(24px, 휴대폰 16px) · 위 여백 16(휴대폰 12) · 파란 안내(note inf) · 버튼 없음(구독은 설정 › 이용권) · 체험 중인 모든 파트너스 화면에 같은 자리 · 마지막 날은 「체험이 오늘 끝납니다」 · 끝나는 날을 아직 못 받았으면 「체험 중입니다」</span></div></div>'
    '<div class="st"><span class="st-tag">공통 띠 · 결제 실패 · 이용 종료</span>' + COL + frame(band('cau', '구독료 결제가 되지 않았습니다', '결제 카드를 확인해 주십시오. 며칠 안에 결제되지 않으면 새 판매가 중지됩니다') + band('neg', '이용 기간이 끝났습니다', '지금은 상품 등록 · 수정과 새 판매가 중지되어 있습니다. 구독하면 바로 다시 사용할 수 있습니다')) +
    '<span class="hint">같은 자리 · 한 번에 하나만 · 결제 실패는 노란 주의(note cau), 이용 종료는 빨간 경고(note neg) · 직원에게는 「대표자에게 구독을 요청해 주십시오」</span></div></div>' + END)
wr('SA-001.dc.html', s)

# ── SH-001-IA(휴대폰) · SH-001-PC-IA(PC): SA-060 상단 공지 한 줄 · 바닥글 카카오톡 문의 버튼 · 유튜브 채널 링크
TOPN = '무통장 입금은 입금자명을 방송 닉네임과 같게 적어 주세요'
SNS_M = '<div class="sns"><a class="btn kakao" href="#">카카오톡 문의</a><a class="ylink" href="#"><i></i>유튜브 채널</a></div>'
SNS_PC = '<div class="sns"><a class="btn s kakao" href="#">카카오톡 문의</a><a class="ylink" href="#"><i></i>유튜브 채널</a></div>'
HINT_SNS = ('<span class="hint">SA-060 쇼핑몰 정보의 「상단 공지 (한 줄)」 「카카오톡 채널 주소」 「유튜브 채널 주소」를 그대로 보여요 · 비어 있으면 띠 · 버튼 · 링크를 숨겨요 · '
            '상단 공지: 모든 쇼핑몰 화면 맨 위 한 줄(32px · 짙은 바탕 · 가운데 · 링크 · 닫기 없음 · 넘치면 말줄임, 홈 「공지」 띠 · 이벤트 「상단 띠 팝업」과 별개) · '
            '카카오톡 문의 버튼(노란 바탕 · 새 창) · 유튜브 채널 링크(빨간 ▶ 아이콘 · 새 창): PC는 바닥글 고객센터 줄 오른쪽 끝, 휴대폰은 바닥글 링크 줄 아래 버튼 44px 전체 폭 + 링크 한 줄</span>')
s = rd('SH-001-IA.dc.html')
s = rep(s, '<div class="mh">', f'<div class="topn">{TOPN}</div><div class="mh">')
s = rep(s, '<a href="SH-026.dc.html">문의하기</a></div><div>[상호] · 대표', f'<a href="SH-026.dc.html">문의하기</a></div>{SNS_M}<div>[상호] · 대표')
s = rep(s, END, '<div class="st"><span class="st-tag">상단 공지 · 카카오톡 문의 · 유튜브 채널 (SA-060 값)</span>' + COL + SH + HINT_SNS + '</div></div></div>' + END)
wr('SH-001-IA.dc.html', s)
s = rd('SH-001-PC-IA.dc.html')
assert s.count('<div class="tb">') == 2
s = s.replace('<div class="sh24" style="width: 100%"><div class="tb">', f'<div class="sh24" style="width: 100%"><div class="topn"><div class="in">{TOPN}</div></div><div class="tb">', 1)
assert s.count('<div class="topn">') == 1
s = rep(s, '<span>문의는 1영업일 안에 답해 드려요</span></div></div>', f'<span>문의는 1영업일 안에 답해 드려요</span></div>{SNS_PC}</div>')
s = rep(s, '\n</div>\n</x-dc>', '<div class="st"><span class="st-tag">상단 공지 · 카카오톡 문의 · 유튜브 채널 (SA-060 값)</span>' + COL + SH + HINT_SNS + '</div></div></div>' + '\n</div>\n</x-dc>')
wr('SH-001-PC-IA.dc.html', s)

# ── SH-030 · SH-030-PC: 이용안내는 파트너스가 쓴 글(SA-060 usageGuide) 그대로(줄바꿈 유지) · 없음 상태(#830)
GUIDE = ('주문 · 방송\n방송 중 주문은 결제가 끝난 순서대로 방송에서 열어요. 내 차례 2건 전에 알림톡(안 되면 문자)으로 알려 드려요. 방송이 아닐 때 주문하면 다음 방송에서 순서대로 열어요.\n\n'
         '배송\n개봉이 끝난 뒤 2영업일 안에 보내요. 배송비 3,000원 · 5만 원 이상 무료 · 제주 · 도서 3,000원 추가. 방송 뒤 직접 수령도 고를 수 있어요.\n\n'
         '취소 · 환불\n개봉 전 주문은 주문 상세에서 취소할 수 있어요. 개봉을 시작하면 취소 · 환불이 안 돼요 (전자상거래법 제17조 제2항). 상품이 설명과 다르거나 잘못 왔으면 받은 날부터 3일 안에 문의해 주세요.\n\n'
         '교환 · 반품\n봉인을 뜯지 않은 상품은 받은 날부터 7일 안에 신청할 수 있어요. 반품 배송비는 구매자 부담, 판매자 사유는 판매자 부담이에요.\n\n'
         '적립금\n개봉 완료 뒤 등급별 비율로 쌓여요 (실버 1% · 골드 2% · VIP 3%). 이 쇼핑몰에서만 쓸 수 있고 마지막 적립 후 3년이 지나면 사라져요.\n\n'
         '개봉 영상\n방송 다시보기에서 내 개봉 시각을 찾아볼 수 있어요. 주문 상세에 시각이 적혀요.\n\n'
         '고객센터\n[고객센터 전화] · 평일 13:00~18:00 · 내 문의에서도 받아요. 문의는 1영업일 안에 답해 드려요.')
GUIDE_HTML = f'<div class="guide" style="white-space: pre-line; font-size: 13px; line-height: 20px; overflow-wrap: anywhere">{GUIDE}</div>'
EMPTY = st('이용안내 없음', '<div class="ct"><span class="ico">!</span><h1>아직 이용안내가 없어요</h1><p>판매자가 올리면 여기에 보여요</p><div></div></div>')
HINT_G = '<span class="hint">파트너스가 쇼핑몰 정보(SA-060)에 쓴 이용안내 글을 줄바꿈 그대로 보여요 · 소제목 · 순서는 글 안에서 파트너스가 적어요(구역 나눔 없음) · 긴 글은 줄바꿈, 가로 스크롤 없음</span>'
for f in ('SH-030', 'SH-030-PC'):
    s = rd(f'{f}.dc.html')
    m = re.search(r'<h2>이용안내</h2>(.*?)<div style="padding-top: 12px"><table class="ft2">.*?</table></div>', s, flags=re.S)
    assert m and '지급일부터 1년 뒤 사라져요' in m.group(0), f
    s = s[:m.start()] + '<h2>이용안내</h2>' + m.group(1) + '<div style="padding-top: 12px">' + GUIDE_HTML + HINT_G + '</div>' + s[m.end():]
    assert '지급일부터 1년 뒤' not in s
    s = rep(s, END, EMPTY + END)
    wr(f'{f}.dc.html', s)

# ── lop.css: 구매자 상단 공지 띠 · 바닥글 카카오톡 · 유튜브
s = rd('lop.css')
assert '.sh24 .topn' not in s
s = rep(s, '.sh24 .tb{background:#fff;border-bottom:1px solid var(--ln2);font-size:12px;color:var(--sub)}',
        '.sh24 .topn{height:32px;line-height:32px;background:var(--ink);color:#fff;font-size:12px;text-align:center;padding:0 16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sh24 .topn .in{width:1200px;margin:0 auto;overflow:hidden;text-overflow:ellipsis}\n'
        '.sh24 .tb{background:#fff;border-bottom:1px solid var(--ln2);font-size:12px;color:var(--sub)}')
s = rep(s, '.sh24 .ft .cs b{display:block;font-size:16px;color:var(--ink)}',
        '.sh24 .ft .cs b{display:block;font-size:16px;color:var(--ink)}\n'
        '.sh24 .ft .cs .sns{margin-left:auto;display:flex;flex-direction:column;gap:8px;align-items:flex-end;justify-content:center}.sh24 .btn.kakao{background:#fee500;border-color:#fee500;color:#191919}.sh24 .ylink{display:inline-flex;align-items:center;gap:6px;color:var(--ink);font-weight:600;font-size:12px}.sh24 .ylink i{width:16px;height:12px;border-radius:3px;background:#f00;position:relative;flex:none}.sh24 .ylink i::after{content:"";position:absolute;left:6px;top:3px;border-left:5px solid #fff;border-top:3px solid transparent;border-bottom:3px solid transparent}')
s = rep(s, '.sh24.m .mft .lk{display:flex;gap:12px;color:var(--ink);font-weight:600;font-size:12px}',
        '.sh24.m .mft .lk{display:flex;gap:12px;color:var(--ink);font-weight:600;font-size:12px}\n.sh24.m .mft .sns{display:flex;flex-direction:column;gap:8px;align-items:flex-start}.sh24.m .mft .sns .btn{height:44px;width:100%;font-size:14px}')
wr('lop.css', s)
print('done')

# ── canvas.json: 보드 높이(실제 렌더 + 20을 10 단위 올림, 커질 때만)
import json
c = json.loads(rd('canvas.json'))
H = {'SA-031.dc.html': 2640, 'DS-TABLE-CARD.dc.html': 3770, 'SH-022-IA.dc.html': 5220, 'SH-001-IA.dc.html': 3010, 'SH-001-PC-IA.dc.html': 4170, 'SH-030.dc.html': 2010, 'SH-030-PC.dc.html': 2570}
for k, h in H.items():
    assert c['boards'][k]['h'] < h, (k, c['boards'][k]['h'], h)
    c['boards'][k]['h'] = h
c['boards']['SH-022-IA.dc.html']['title'] = c['boards']['SH-022-IA.dc.html']['title'].replace('· 오류 상태)', '· 오류 상태 · 현금영수증 · 세금계산서 신청)')
wr('canvas.json', json.dumps(c, ensure_ascii=False, indent=2) + ('\n' if rd('canvas.json').endswith('\n') else ''))
