#!/usr/bin/env python3
"""보드 반영 묶음 7 (디자인 전담 (6), MASTER 승인 2026-10-06 · #862 병합 뒤):
① MA-027 환불 처리: 「CS 검토 → 최고관리자 승인」 2단계 문구 제거 → 「요청 내용 → 최고관리자 승인/거절」 1단계 (MA-026 v325 와 일치)
② MA-090 내 계정: 설정 LNB를 다른 설정 보드와 같은 구조(시스템 8항목 + 관리자 3항목 · 「플랫폼 정보」 포함)로 통일
사용: gen-board-sync7.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리> [높이 json]"""
import sys, re, pathlib, json, math
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))

# ── ① MA-027 1단계
s = rd('MA-027.dc.html')
s = rep(s, '검토 박CS (CS) 2026.10.02 14:00 → 최고관리자 승인 필요', '최고관리자 승인 대기')
s = rep(s, '<tr><th>CS 검토 의견</th><td>박CS · 2026.10.02 14:00 · 전액 환불이 맞습니다. 같은 문제를 겪은 파트너스 2명을 더 확인해야 합니다.</td></tr>', '')
s = rep(s, '<tr><th>검토자</th><td>박CS</td></tr>', '')
s = rep(s, '<tr><th>실행자</th><td>대표 (나)</td></tr>', '<tr><th>승인 · 실행</th><td>최고관리자 (나)</td></tr>')
s = rep(s, '검토 의견을 확인했고 환불을 승인합니다', '요청 내용을 확인했고 환불을 승인합니다')
s = rep(s, '<tr><td>14:00</td><td class="l">CS 검토 완료 · 승인 요청</td></tr><tr><td>09:30</td><td class="l">담당 배정 박CS</td></tr>', '')
s = rep(s, '필요한 권한: 환불 처리', '필요한 권한: 환불 승인 (최고관리자)')
# CS · 운영 화면 상태 변형: 승인 요청 단계 없음 → 조회만
m = re.search(r'<div class="st"><span class="st-tag">CS · 운영 화면</span>.*?</div></div>(?=<div class="st">)', s)
assert m and '승인 요청' in m.group(0)
s = s.replace(m.group(0), '<div class="st"><span class="st-tag">CS · 운영 관리자 화면</span><div class="col" style="width: 100%; text-align: left; gap: 8px; align-items: flex-start"><span class="tag bl">승인 대기</span><div class="note inf" style="width: 100%">환불 승인 · 거절은 최고관리자만 할 수 있습니다 · 요청 내용과 중복 확인은 볼 수 있고 「승인 · 환불 실행」 · 「거절」 버튼은 보이지 않습니다</div></div></div>')
for bad in ['검토', '박CS', '승인 요청']: assert bad not in s, bad
wr('MA-027.dc.html', s)

# ── ② MA-090 설정 LNB 통일
s = rd('MA-090.dc.html')
s = rep(s, '<aside class="lnb"><div class="lnb-t">설정</div><a class="" href="MA-081.dc.html">플랫폼 기본 정책</a><a class="" href="MA-082.dc.html">알림 채널</a><a class="" href="MA-083.dc.html">점검 모드</a><a class="" href="MA-084.dc.html">도우미 설정</a><a class="" href="MA-085.dc.html">파비콘 · 공유 카드</a><a class="" href="MA-086.dc.html">발송 단가</a></aside>',
        '<aside class="lnb"><div class="lnb-t">설정</div><div class="lnb-h">시스템</div><a class="" href="MA-081.dc.html">플랫폼 기본 정책</a><a class="" href="MA-082.dc.html">알림 채널</a><a class="" href="MA-083.dc.html">점검 모드</a><a class="" href="MA-084.dc.html">도우미 설정</a><a class="" href="MA-085.dc.html">파비콘 · 공유 카드</a><a class="" href="MA-086.dc.html">발송 단가</a><a class="" href="MA-087.dc.html">외부 서비스 연동</a><a class="" href="MA-088.dc.html">플랫폼 정보</a><div class="lnb-h">관리자</div><a class="" href="MA-061.dc.html">관리자 계정</a><a class="" href="MA-063.dc.html">역할별 권한</a><a class="" href="MA-070.dc.html">로그 추적</a></aside>')
wr('MA-090.dc.html', s)

c = json.loads(rd('canvas.json'))
c['boards']['MA-027.dc.html']['title'] = 'MA-027 환불 처리 (카페24식 · 요청 · 환불 내용 · 최고관리자 승인/거절 1단계 · 이력)'
for k, h in (json.loads(pathlib.Path(sys.argv[3]).read_text()).items() if len(sys.argv) > 3 else []):
    want = math.ceil((h + 20) / 10) * 10
    if c['boards'][k]['h'] < want: print('height', k, c['boards'][k]['h'], '->', want); c['boards'][k]['h'] = want
wr('canvas.json', json.dumps(c, ensure_ascii=False, indent=2) + '\n')
print('done')
