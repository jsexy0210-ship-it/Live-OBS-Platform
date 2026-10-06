#!/usr/bin/env python3
"""보드 반영 묶음 9 — 「구조가 정본과 다른 화면」 판정 중 MASTER 승인(2026-10-06 「A 전체 승인」) 삭제 · 수정 6건 + 검수 (10) 조사 정정 2건.
① MA-063 역할별 권한: 「변경 · 조회 · 승인 요청」 3단계 → 「가능/—」 2값 · 서버 권한 표(lib/server/authz/permissions.ts 14개) 그대로 (docs/ARCHITECTURE.md 3.2 O/X · MASTER 2026-10-06 고정 역할 조회만)
② MA-083 점검 모드: 「시작 시 진행 중 방송 자동 종료 · 대기 주문 이월」 체크 · 안내 문구 · 「연장 +30분」 · 자동 종료 표현 삭제 (lib/server/maintenance/service.ts:10-12 오버레이 유지 · 자동으로 끄지 않음)
③ MA-084 도우미 설정: 「답하지 못할 때: 안내만 합니다」 선택지 삭제 → 고정 안내 (docs/IA.md:207 문의하기로 연결)
④ MA-031 결제 연결 상태: 집계 대상 「모든 파트너스 구독 결제」 → 「모든 파트너스 쇼핑몰 주문 결제」 (CLAUDE.md 결제 구조 · IA:193 SA-070 폐지 · adminStatus.ts Payment 집계)
⑤ SA-025 배송: 「합배송 가능」 필터 삭제 (PRODUCT_SCOPE:93 · ARCHITECTURE:483 보관 · 합배송은 출시 후 1차)
⑥ PF-002 기능 안내: 「운영팀 평균 첫 답변 4시간」 삭제 (근거 없는 약속 수치)
⑦ PF-001 「방송 화면를」 → 「방송 화면을」 · PF-004 「방송 화면가」 → 「방송 화면이」 (검수 (10) 요청, #899)
⑨ MA-051 · MA-052 플랫폼 문의: 상태 이름 「미답변 · 진행 중 · 종료」 → 「답변 대기 · 답변 완료 · 종료」(MASTER (4) 배정 · SA-113 「접수 · 답변 완료 · 종료」와 용어 일치) · MA-052 「방송 화면가」 → 「방송 화면이」
⑧ MA-088 플랫폼 정보: 변경 이력 「이전 → 이후 값」 → 「바뀐 항목 이름」 기준 (MASTER (4) 배정 · #846 결정: 로그에는 칸 이름만 저장 · 서버 · 화면 #876 · #920 이름 기준)
사용: gen-board-sync9.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리> [높이 json]"""
import sys, re, pathlib, json, math
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))

# ① MA-063
s = rd('MA-063.dc.html')
P = [('화면 보기 · 기록', [('모든 화면 보기', 'platform.read', 'SOCR'), ('로그 추적 조회', 'audit.read', 'SO R')]),
     ('파트너스', [('파트너스 이용 정지 · 해제', 'seller.moderate', 'SO  '), ('파트너스 화면 대신 보기', 'seller.impersonate', 'SOC ')]),
     ('요금 · 결제', [('청구 · 요금 관리', 'billing.manage', 'SO  '), ('요금제 가격 변경', 'billing.price', 'S   '), ('구독 환불 승인', 'billing.refund', 'S   ')]),
     ('고객지원', [('고객지원 관리', 'support.manage', 'S C '), ('파트너스 문의 담당 배정', 'support.assign', 'SOC ')]),
     ('설정 · 관리', [('관리자 계정 관리', 'admin.manage', 'S   '), ('서비스 설정 바꾸기', 'system.manage', 'S   '), ('인프라 · 비용', 'infra.manage', 'S   '), ('외부 서비스 업체 관리', 'vendor.manage', 'SO  ')])]
cell = lambda ok: '<td><span class="tag g">가능</span></td>' if ok else '<td><span class="tag n">—</span></td>'
rows = ''
for g, items in P:
    rows += f'<tr><td class="l"><b>{g}</b></td><td colspan="4" style="background: var(--c24-th)"></td></tr>'
    for label, key, m in items:
        rows += f'<tr><td class="l">{label} <span class="nt">{key}</span></td>' + ''.join(cell(c != ' ') for c in m) + '</tr>'
a = s.index('<div class="ltop"><span><span class="tag g">변경</span>'); b = s.index('</table>', a) + len('</table>')
s = s[:a] + ('<div class="ltop"><span><span class="tag g">가능</span> 할 수 있음 &nbsp; <span class="tag n">—</span> 할 수 없음 · 메뉴가 보이지 않습니다</span></div>'
  '<table class="lt"><thead><tr><th>기능 <span class="nt">(작은 글자는 서버 권한 키)</span></th><th style="width: 140px">최고관리자 (1)</th><th style="width: 140px">운영 (2)</th><th style="width: 140px">CS (2)</th><th style="width: 140px">조회 전용 (1)</th></tr></thead><tbody>' + rows + '</tbody></table>') + s[b:]
s = rep(s, '4개 역할이 할 수 있는 일을 정리한 고정 표입니다 · 이 화면에서는 조회만 할 수 있습니다 · 권한 정본은 서버의 권한 표입니다',
        '4개 역할이 할 수 있는 일을 정리한 고정 표입니다 · 이 화면에서는 조회만 할 수 있습니다 · 권한 정본은 서버의 권한 표(14개)이며 「가능」과 「—」 두 값뿐입니다 · 최고관리자는 한 명뿐이고 시드로만 만듭니다')
for bad in ['승인 요청', '>변경<', '>조회<']: assert bad not in s, bad
wr('MA-063.dc.html', s)

# ② MA-083
s = rd('MA-083.dc.html')
s = rep(s, ' · 진행 중인 방송은 자동 종료되고 대기 주문은 이월됩니다</div>', ' · 방송 화면과 주문대기 연결은 꺼지지 않게 그대로 열립니다 · 종료 예정 시각이 지나도 자동으로 꺼지지 않으니 「점검 종료」를 눌러 주십시오</div>')
s = rep(s, '<label class="ck"><input type="checkbox" name="r" checked>시작 시 진행 중 방송 자동 종료 · 대기 주문 이월</label>', '')
s = rep(s, '<b>점검 중</b> · 03:00부터 · 남은 1:12 <span style="float: right">연장 +30분 · 점검 종료</span></div><span class="hint">상단 주황 띠 고정 · 「점검 종료」 버튼 · 연장 +30분</span>',
        '<b>점검 중</b> · 03:00부터 · 종료 예정 03:40 <span style="float: right">점검 종료</span></div><span class="hint">상단 주황 띠 고정 · 「점검 종료」 버튼 · 종료 예정 시각이 지나도 자동으로 꺼지지 않습니다</span>')
for bad in ['자동 종료', '연장 +30분']: assert bad not in s, bad
wr('MA-083.dc.html', s)

# ③ MA-084
s = rd('MA-084.dc.html')
s = rep(s, '<tr><th>답하지 못할 때</th><td><div class="col" style="gap: 4px; align-items: flex-start"><label class="ck"><input type="radio" name="nf" checked>문의하기로 이어 줍니다 (기본)</label><span class="hint">질문 내용이 문의 작성란에 미리 들어갑니다</span><label class="ck"><input type="radio" name="nf">안내만 합니다</label><span class="hint">「답할 수 없는 내용입니다」만 보여줍니다</span></div></td></tr>',
        '<tr><th>답하지 못할 때</th><td>문의하기로 이어 줍니다 (고정)<span class="hint">질문 내용이 문의 작성란에 미리 들어갑니다 · 범위 밖 질문은 정중히 거절하고 문의하기로 안내합니다</span></td></tr>')
assert '안내만 합니다' not in s
wr('MA-084.dc.html', s)

# ④ MA-031
s = rd('MA-031.dc.html')
s = rep(s, '나이스페이 · 플랫폼 키 1개로 모든 파트너스 구독 결제를 처리합니다', '나이스페이 · 플랫폼 키 1개로 모든 파트너스 쇼핑몰 주문 결제를 처리합니다 (파트너스 구독료 청구는 청구 내역에서)')
s = rep(s, '모든 구독 결제 · 재시도가 멈춥니다', '모든 쇼핑몰 주문 결제가 멈춥니다')
assert '구독 결제' not in s
wr('MA-031.dc.html', s)

# ⑤ SA-025
s = rd('SA-025.dc.html')
s = rep(s, '<label class="ck"><input type="checkbox" name="r">합배송 가능</label>', '')
assert '합배송' not in s
wr('SA-025.dc.html', s)

# ⑥ PF-002
s = rd('PF-002.dc.html')
m = re.search(r'<span class="row t-l1" style="gap: 8px"><span style="color: var\(--pos-text\)"><svg[^<]*<path d="M5 12l5 5L20 7"></path></svg></span><span class="c-neu">운영팀 평균 첫 답변 4시간</span></span>', s); assert m
s = s.replace(m.group(0), '')
wr('PF-002.dc.html', s)

# ⑦ PF-001 · PF-004 조사
s = rd('PF-001.dc.html'); s = rep(s, '방송 화면를', '방송 화면을'); wr('PF-001.dc.html', s)
s = rd('PF-004.dc.html'); s = rep(s, '방송 화면가', '방송 화면이'); wr('PF-004.dc.html', s)

# ⑧ MA-088
s = rd('MA-088.dc.html')
s = rep(s, '<span class="nt">저장할 때마다 항목별 이전 → 이후 값이 로그 추적에 남습니다</span>', '<span class="nt">저장할 때마다 바뀐 항목 이름이 로그 추적에 남습니다 · 값은 남기지 않습니다</span>')
s = rep(s, '<thead><tr><th style="width: 136px">일시</th><th style="width: 160px">항목</th><th>변경 (이전 → 이후)</th><th style="width: 140px">처리</th></tr></thead><tbody><tr><td colspan="4" class="l" style="color: var(--c24-sub)">아직 변경 기록이 없습니다</td></tr></tbody>',
        '<thead><tr><th style="width: 136px">일시</th><th>바뀐 항목</th><th style="width: 140px">처리</th></tr></thead><tbody><tr><td colspan="3" class="l" style="color: var(--c24-sub)">아직 변경 기록이 없습니다</td></tr></tbody>')
assert '이전 → 이후' not in s
wr('MA-088.dc.html', s)

# ⑨ MA-051 · MA-052 상태 이름
s = rd('MA-051.dc.html')
s = rep(s, '<div class="k">미답변</div>', '<div class="k">답변 대기</div>')
s = rep(s, '>미답변 7</label>', '>답변 대기 7</label>')
s = rep(s, '>진행 중 5</label>', '>답변 완료 5</label>')
s = rep(s, '<span class="tag y">미답변</span>', '<span class="tag y">답변 대기</span>', 7)
s = rep(s, '<span class="tag bl">진행 중</span>', '<span class="tag bl">답변 완료</span>')
s = rep(s, '<b>미답변 문의가 없습니다</b>', '<b>답변 대기 문의가 없습니다</b>')
for bad in ['미답변', '진행 중']: assert bad not in s, bad
wr('MA-051.dc.html', s)
s = rd('MA-052.dc.html')
s = rep(s, '<span class="tag y">미답변 · 42분</span>', '<span class="tag y">답변 대기 · 42분</span>')
s = rep(s, '상태 「진행 중」 · 파트너스 추가 문의 대기', '상태 「답변 완료」 · 파트너스 추가 문의 대기')
s = rep(s, '방송 화면가 안 뜹니다', '방송 화면이 안 뜹니다')
for bad in ['미답변', '「진행 중」', '방송 화면가']: assert bad not in s, bad
wr('MA-052.dc.html', s)

c = json.loads(rd('canvas.json'))
c['boards']['MA-063.dc.html']['title'] = 'MA-063 역할별 권한 표 (서버 권한 14개 · 가능/— 2값 · 고정 · 조회만)'
for k, h in (json.loads(pathlib.Path(sys.argv[3]).read_text()).items() if len(sys.argv) > 3 else []):
    want = math.ceil((h + 20) / 10) * 10
    if c['boards'][k]['h'] < want: print('height', k, c['boards'][k]['h'], '->', want); c['boards'][k]['h'] = want
wr('canvas.json', json.dumps(c, ensure_ascii=False, indent=2) + '\n')
print('done')
