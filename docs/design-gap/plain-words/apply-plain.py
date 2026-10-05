#!/usr/bin/env python3
"""쉬운 말 문구 일괄(#644 SH · #649 MA 「디자인 문구 반영 대기」) — FINAL 보드만. #652 병합 뒤 실행.
MASTER 결정: 관리자 「다시 시도」 유지, 구매자만 「다시 불러오기」."""
import os, re, sys
ROOT = '/home/user/Live-OBS-Platform/design/project'
FINAL = [l.strip() for l in open(os.path.dirname(__file__) + '/final.txt') if l.strip()]

# 구매자(SH) FINAL 보드 — 해요체
SH = [
 ('>다시 시도<', '>다시 불러오기<'),
 ('SOLD OUT', '품절'),
 ('구매안전서비스', '구매 안전 서비스'),
 ('>결제 대기<', '>결제 전<'),
 ('>취소됨<', '>취소했어요<'),
 ('>환불됨<', '>환불했어요<'),
 ('>요청 철회<', '>취소 요청 거두기<'),
 ('>신청 철회<', '>신청 거두기<'),
 ('>철회했어요<', '>요청을 거뒀어요<'),
 ('마케팅 정보 받기', '이벤트·할인 소식 받기'),
 ('(선택) 마케팅 정보 수신', '(선택) 이벤트·할인 소식 받기'),
 ('🔒 비밀글입니다', '🔒 비밀글이에요'),
 ('10자 이상 써 주시면', '10자 이상 써야 올릴 수 있어요'),
 ('본인확인 약관에 모두 동의해요', '위 내용에 모두 동의하고 본인 확인을 시작해요'),
 ('>등록<', '>쿠폰 코드 등록하기<'),  # SH-008 쿠폰함만 — 아래 ONLY로 제한
]
SH_ONLY = {'>등록<': ['SH-008'], '>받기<': ['SH-008']}

# 마스터(MA) FINAL 보드 — 합니다체·명사형 (「다시 시도」 유지)
MA = [
 ('가입 승인 대기', '가입 신청 처리 대기'),
 ('PG 연결 오류', '카드 결제 연결 오류'),
 ('심각 장애', '바로 확인할 문제'),
 ('>순매출<', '>환불을 뺀 매출<'),
 ('>수납 매출<', '>받은 구독료<'),
 ('>수납률<', '>구독료 받은 비율<'),
 ('>체험<', '>무료 체험 중<'),
 ('결제 처리 중', '결제 진행 중'),
 ('>승인 대기<', '>가입 신청 중<'),
 ('>확인 필요<', '>확인할 것<'),
 ('>이상 없음<', '>확인할 것 없음<'),
 ('>검토<', '>확인할 내용 보기<'),
 ('확인 뒤 승인', '확인했습니다. 승인'),
 ('자동 점검', '자동으로 확인한 결과'),
 ('걸린 항목', '문제가 된 항목'),
 ('대리 조회', '이 파트너스 화면 대신 보기'),
 ('>환불됨<', '>환불 완료<'),
 ('>파비콘<', '>탭 아이콘(파비콘)<'),
 ('>공유 카드<', '>공유 미리보기 카드<'),
 ('>정기결제<', '>자동 반복 결제<'),
 ('>에스크로<', '>안전결제(에스크로)<'),
 ('>역할별 권한<', '>역할별로 할 수 있는 일<'),
 ('>시스템 설정<', '>서비스 설정 바꾸기<'),
 ('>전체 조회<', '>모든 화면 보기<'),
 ('플랫폼 운영 계정으로 로그인', '마스터 관리자 계정으로 로그인'),
]
MA_SKIP_IN_LNB = True  # LNB 메뉴명(역할별 권한 · 파비콘 · 공유 카드)은 DS-NAV 확정 메뉴명이라 바꾸지 않음

def apply(fn, pairs, only=None):
    s = open(fn).read(); o = s; done = []
    bid = os.path.basename(fn)[:6]
    for a, b in pairs:
        if only and a in only and bid not in only[a]: continue
        if a in s:
            if MA_SKIP_IN_LNB and bid.startswith('MA'):
                # LNB 안은 보존
                lnb = re.search(r'<aside class="lnb">.*?</aside>', s, re.S)
                head, body = (s[:lnb.end()], s[lnb.end():]) if lnb else ('', s)
                if a in body:
                    body = body.replace(a, b); s = head + body; done.append(a)
            else:
                s = s.replace(a, b); done.append(a)
    if s != o: open(fn, 'w').write(s)
    return done

if __name__ == '__main__':
    for f in FINAL:
        p = f'{ROOT}/{f}'
        if not os.path.exists(p): continue
        if f.startswith('SH'): d = apply(p, SH, SH_ONLY)
        elif f.startswith('MA') or f.startswith('AU'): d = apply(p, MA)
        else: d = []  # SA FINAL은 화면-파트너스 PR 목록 뒤
        if d: print(f, d)
