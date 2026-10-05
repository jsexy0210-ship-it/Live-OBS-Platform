#!/usr/bin/env python3
"""새 GNB·LNB(DS-NAV 확정) · ← 버튼 · 통합 탭 · 경로 줄을 SA/MA 보드에 일괄 적용."""
import re, sys, glob, os, html

ROOT = '/home/user/Live-OBS-Platform/design/project'
ARROW = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4 6.5 10l6 6"/></svg>'

SA_GNB = [('홈','SA-002-IA'),('방송','SA-001'),('주문','SA-021'),('상품','SA-011'),('고객','SA-041'),('마케팅','SA-035'),('통계','SA-056'),('설정','SA-060')]
SA_LNB = {
 '홈': [('홈','SA-002-IA')],
 '방송': [('방송 대시보드','SA-001'),('방송 화면 꾸미기','SA-051'),('방송 기록','SA-054'),('외부 채널 연결','SA-006')],
 '주문': [('전체 주문','SA-021'),('입금 확인','SA-026'),('배송 · 송장','SA-025'),('취소 · 교환 · 반품','SA-029'),('영수증 · 세금계산서','SA-024')],
 '상품': [('상품 목록','SA-011'),('상품 등록','SA-012'),('재고','SA-014'),('분류 · 진열','SA-015'),('엑셀로 올리기 · 내려받기','SA-018')],
 '고객': [('회원 목록','SA-041'),('회원 등급','SA-044'),('구매 제한','SA-043'),('회원에게 알림 보내기','SA-049'),('적립금','SA-031'),('문의 · 리뷰','SA-046')],
 '마케팅': [('쿠폰','SA-035'),('홈 배너','SA-064'),('이벤트 팝업','SA-065'),('쇼핑몰 공지 · 자주 묻는 질문','SA-066')],
 '통계': [('통계','SA-056')],
 '설정': [('쇼핑몰 정보','SA-060'),('주문 · 배송 설정','SA-063'),('약관 · 회원 정책','SA-062'),('검색 노출','SA-067'),('알림 설정','SA-080'),('충전금','SA-081'),('직원 계정','SA-100'),('구독 · 결제','SA-090'),('쇼핑몰 통합 전환','SA-005')],
}
SA_LNB_H = {}  # no sub headings for SA
SA_MAP = {}
def m(group, item, *ids):
    for i in ids: SA_MAP[i] = (group, item)
m('홈','홈','SA-002','SA-003','SA-004')
m('방송','방송 대시보드','SA-001'); m('방송','방송 화면 꾸미기','SA-051','SA-052'); m('방송','방송 기록','SA-053','SA-054','SA-055'); m('방송','외부 채널 연결','SA-006','SA-057','SA-150','SA-151','SA-152','SA-153')
m('주문','전체 주문','SA-021','SA-022'); m('주문','입금 확인','SA-026'); m('주문','배송 · 송장','SA-025','SA-027','SA-028'); m('주문','취소 · 교환 · 반품','SA-023','SA-029'); m('주문','영수증 · 세금계산서','SA-024')
m('상품','상품 목록','SA-011','SA-013'); m('상품','상품 등록','SA-012'); m('상품','재고','SA-014','SA-017'); m('상품','분류 · 진열','SA-015','SA-016'); m('상품','엑셀로 올리기 · 내려받기','SA-018')
m('고객','회원 목록','SA-041','SA-042'); m('고객','회원 등급','SA-044'); m('고객','구매 제한','SA-043'); m('고객','회원에게 알림 보내기','SA-049'); m('고객','적립금','SA-031','SA-032','SA-033','SA-034'); m('고객','문의 · 리뷰','SA-046','SA-047','SA-048')
m('마케팅','쿠폰','SA-035'); m('마케팅','홈 배너','SA-064'); m('마케팅','이벤트 팝업','SA-065'); m('마케팅','쇼핑몰 공지 · 자주 묻는 질문','SA-066')
m('통계','통계','SA-056')
m('설정','쇼핑몰 정보','SA-060'); m('설정','주문 · 배송 설정','SA-061','SA-063','SA-082'); m('설정','약관 · 회원 정책','SA-062','SA-068'); m('설정','검색 노출','SA-067'); m('설정','알림 설정','SA-080'); m('설정','충전금','SA-081'); m('설정','직원 계정','SA-100'); m('설정','구독 · 결제','SA-090'); m('설정','쇼핑몰 통합 전환','SA-005')
SA_TABS = {
 '방송 화면 꾸미기': [('편집기','SA-051'),('방송 프로그램에 넣기','SA-052')],
 '방송 기록': [('방송별','SA-054'),('히트 카드','SA-053')],
 '외부 채널 연결': [('유튜브','SA-057'),('외부 쇼핑몰','SA-006'),('자동 연결','SA-150')],
 '배송 · 송장': [('배송 준비','SA-025'),('송장 발급','SA-027'),('출력 · 추적','SA-028')],
 '취소 · 교환 · 반품': [('취소 · 환불','SA-023'),('교환 · 반품','SA-029')],
 '재고': [('재고 수정','SA-014'),('재입고 알림','SA-017')],
 '분류 · 진열': [('카테고리','SA-015'),('홈 진열','SA-016')],
 '적립금': [('적립 정책','SA-031'),('지급 · 회수 원장','SA-032'),('회원별 잔액','SA-033'),('실제 지급 켜기','SA-034')],
 '문의 · 리뷰': [('문의','SA-046'),('리뷰','SA-048')],
 '주문 · 배송 설정': [('주문 설정','SA-063'),('배송비 정책','SA-061'),('배송 자동화','SA-082')],
 '약관 · 회원 정책': [('법정 고지 · 약관','SA-062'),('회원 정책','SA-068')],
}
SA_TOP = {i for g in SA_LNB.values() for _, i in g} | {'SA-002','SA-111','SA-120','SA-130','SA-140'}
SA_TOP |= {i for tabs in SA_TABS.values() for _, i in tabs}  # 탭으로 들어가는 화면은 메뉴 화면과 같은 급 → ← 없음

MA_GNB = [('홈','MA-001'),('파트너스','MA-011'),('요금 · 결제','MA-021'),('운영','MA-041'),('고객지원','MA-051'),('설정','MA-081')]
MA_LNB = {
 '홈': [('홈','MA-001')],
 '파트너스': [('파트너스 목록','MA-011'),('가입 신청','MA-013'),('결제 연결 상태','MA-031'),('적립금 실제 지급 켠 파트너스','MA-043')],
 '요금 · 결제': [('요금제','MA-021'),('구독 현황','MA-023'),('청구 · 결제 내역','MA-024'),('구독료 수납','MA-032'),('환불 요청','MA-026')],
 '운영': [('실시간 방송','MA-041'),('주문 · 방송 화면 접속','MA-042'),('실시간 감시','MA-100'),('자동 연결 작업','MA-110')],
 '고객지원': [('파트너스 문의','MA-051'),('공지사항','MA-053'),('도우미 답변 자료','MA-055')],
 '설정': [('H','시스템'),('플랫폼 기본 정책','MA-081'),('알림 채널','MA-082'),('점검 모드','MA-083'),('도우미 설정','MA-084'),('파비콘 · 공유 카드','MA-085'),('발송 단가','MA-086'),('외부 서비스 연동','MA-087'),('H','관리자'),('관리자 계정','MA-061'),('역할별 권한','MA-063'),('로그 추적','MA-070')],
}
MA_MAP = {}
def mm(group, item, *ids):
    for i in ids: MA_MAP[i] = (group, item)
mm('홈','홈','MA-001'); mm('파트너스','파트너스 목록','MA-011','MA-012','MA-014','MA-015','MA-016'); mm('파트너스','가입 신청','MA-013'); mm('파트너스','결제 연결 상태','MA-031'); mm('파트너스','적립금 실제 지급 켠 파트너스','MA-043')
mm('요금 · 결제','요금제','MA-021','MA-022'); mm('요금 · 결제','구독 현황','MA-023'); mm('요금 · 결제','청구 · 결제 내역','MA-024','MA-025'); mm('요금 · 결제','구독료 수납','MA-032'); mm('요금 · 결제','환불 요청','MA-026','MA-027')
mm('운영','실시간 방송','MA-041'); mm('운영','주문 · 방송 화면 접속','MA-042'); mm('운영','실시간 감시','MA-100'); mm('운영','자동 연결 작업','MA-110','MA-111')
mm('고객지원','파트너스 문의','MA-051','MA-052'); mm('고객지원','공지사항','MA-053','MA-054'); mm('고객지원','도우미 답변 자료','MA-055')
for i in ('MA-081','MA-082','MA-083','MA-084','MA-085','MA-086','MA-087'):
    mm('설정', dict((b,a) for a,b in MA_LNB['설정'] if a!='H')[i], i)
mm('설정','관리자 계정','MA-061','MA-062'); mm('설정','역할별 권한','MA-063'); mm('설정','로그 추적','MA-070','MA-071')
MA_TOP = {i for g in MA_LNB.values() for h, i in g if h != 'H'} | {'MA-002','MA-090'}

UTIL_RENAME = [('>쇼핑몰 바로가기<','>쇼핑몰 보기<'),('>알림 센터<','>알림<')]

def base_id(fn):
    return os.path.basename(fn)[:6]

def gnb_html(items, on, extra=None):
    out = ['<nav class="gnb-m">']
    for label, i in items:
        out.append(f'<a class="{"on" if label==on else ""}" href="{i}.dc.html">{label}</a>')
    out.append('</nav>')
    return ''.join(out)

def lnb_html(title, items, on_item):
    out = [f'<aside class="lnb"><div class="lnb-t">{title}</div>']
    for label, i in items:
        if label == 'H':
            out.append(f'<div class="lnb-h">{i}</div>')
        else:
            out.append(f'<a class="{"on" if label==on_item else ""}" href="{i}.dc.html">{label}</a>')
    out.append('</aside>')
    return ''.join(out)

def find_block(s, start_tag, open_tag='<div', close_tag='</div>', pos=0):
    """return (i,j) of balanced div block starting at start_tag."""
    i = s.find(start_tag, pos)
    if i < 0: return None
    depth = 0; k = i
    while True:
        a = s.find(open_tag, k); b = s.find(close_tag, k)
        if b < 0: return None
        if a >= 0 and a < b:
            depth += 1; k = a + len(open_tag)
        else:
            depth -= 1; k = b + len(close_tag)
            if depth == 0: return (i, k)

def strip_tags(t):
    return re.sub(r'<[^>]+>', '', t).strip()

def process(fn, report):
    s = open(fn).read(); orig = s
    bid = base_id(fn); kind = bid[:2]
    if kind == 'SA':
        GNB, LNB, MAP, TABS, TOP = SA_GNB, SA_LNB, SA_MAP, SA_TABS, SA_TOP
    else:
        GNB, LNB, MAP, TABS, TOP = MA_GNB, MA_LNB, MA_MAP, {}, MA_TOP
    group, item = MAP.get(bid, (None, None))
    acts = []
    # 1. GNB
    def repl_gnb(mo):
        old = mo.group(0)
        if 'opacity: .4' in old:  # 오버레이 전용 요금제 · 잠긴 메뉴 변형
            out = ['<nav class="gnb-m">']
            for label, i in GNB:
                if label in ('홈','방송','설정'): out.append(f'<a class="{"on" if label==group else ""}" href="{i}.dc.html">{label}</a>')
                else: out.append(f'<a style="opacity: .4">{label}</a>')
            return ''.join(out) + '</nav>'
        if '업그레이드' in old:
            return ('<nav class="gnb-m"><a href="SA-002-O.dc.html">홈</a><a href="SA-001.dc.html">방송</a>'
                    '<a href="SA-005.dc.html" style="opacity: .75">쇼핑몰 통합 <span class="tag y" style="margin-left: 4px">업그레이드</span></a>'
                    '<a href="SA-060.dc.html">설정</a></nav>')
        if '<a class="on" href="#">' in old:  # 쇼핑몰 등 다른 GNB(숫자 탭 등)는 건드리지 않음
            return old
        return gnb_html(GNB, group)
    n = len(re.findall(r'<nav class="gnb-m">.*?</nav>', s))
    if n:
        s = re.sub(r'<nav class="gnb-m">.*?</nav>', repl_gnb, s); acts.append(f'gnb×{n}')
    for a, b in UTIL_RENAME:
        if a in s: s = s.replace(a, b)
    # 2. LNB
    if group:
        def repl_lnb(mo):
            return lnb_html(group, LNB[group], item)
        n = len(re.findall(r'<aside class="lnb">.*?</aside>', s, re.S))
        if n:
            s = re.sub(r'<aside class="lnb">.*?</aside>', repl_lnb, s, flags=re.S); acts.append(f'lnb×{n}')
    # 3. pathbar · ph2 · ← · tabs
    blk = find_block(s, '<div class="ph2">')
    if blk and group:
        i, j = blk; ph2 = s[i:j]
        h1 = re.search(r'<h1>(.*?)</h1>', ph2, re.S)
        title = strip_tags(h1.group(1)) if h1 else item
        title = re.sub(r'\s*\(.*?\)\s*$', '', title)  # 「(대리 조회 · 읽기 전용)」 같은 꼬리 제거
        is_top = bid in TOP
        parts = [group, item] + ([title] if title != item else [])
        path = ' › '.join(parts)
        # pathbar
        pb = re.search(r'<div class="pathbar">(.*?)</div>', s)
        if pb:
            inner = pb.group(1)
            tail = re.search(r'(\s*<span class="tag.*)$', inner)
            s = s.replace(pb.group(0), f'<div class="pathbar">{html.escape(path, quote=False)}{tail.group(1) if tail else ""}</div>', 1)
            blk = find_block(s, '<div class="ph2">'); i, j = blk; ph2 = s[i:j]
        ph2n = re.sub(r'<span class="path">.*?</span>', f'<span class="path">{html.escape(path, quote=False)}</span>', ph2, count=1, flags=re.S)
        parent = dict((a, b) for a, b in LNB[group] if a != 'H')[item]
        if not is_top and '<a class="bk"' not in ph2n:
            ph2n = ph2n.replace('<div class="ph2">', f'<div class="ph2"><a class="bk" href="{parent}.dc.html" title="뒤로" aria-label="뒤로">{ARROW}</a>', 1); acts.append('←')
        s = s[:i] + ph2n + s[j:]
        j = i + len(ph2n)
        tabs = TABS.get(item)
        if tabs:
            tab_html = '<div class="rtabs">' + ''.join(f'<a class="{"on" if t == bid else ""}" href="{t}.dc.html">{l}</a>' for l, t in tabs) + '</div>'
            after = s[j:j+40]
            ex = re.match(r'\s*<div class="rtabs">.*?</div>', s[j:], re.S)
            if ex and any(t + '.dc.html' in ex.group(0) for _, t in tabs):
                s = s[:j] + tab_html + s[j+ex.end():]; acts.append('tabs=')
            else:
                s = s[:j] + tab_html + s[j:]; acts.append('tabs+')
    elif group and not blk:
        acts.append('no-ph2')
    if s != orig:
        open(fn, 'w').write(s)
    report.append((os.path.basename(fn), group, item, acts))

if __name__ == '__main__':
    files = sorted(glob.glob(ROOT + '/SA-*.dc.html') + glob.glob(ROOT + '/MA-*.dc.html'))
    files = [f for f in files if os.path.basename(f) not in ('SA-LNB.dc.html',)]
    report = []
    for f in files: process(f, report)
    for r in report:
        if r[3]: print(r[0], r[1], r[2], ' '.join(r[3]))
    print('--- unmapped:', [r[0] for r in report if r[1] is None])
