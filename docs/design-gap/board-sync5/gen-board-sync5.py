#!/usr/bin/env python3
"""보드 반영 묶음 5 (디자인 전담 (6), MASTER 추가 배정 2026-10-06):
① PF-009 개인정보처리방침: 「아직 준비 중이에요」 상태 변형 추가(해요체 · 서버 글이 없을 때)
② MA-026 환불 요청: 2단계(검토 → 승인) → 「요청 → 최고관리자 승인」 1단계. 요약 타일 「검토 대기」 삭제 · 「승인 대기 (최고관리자)」로 합산(4열), 상태 태그 「검토 대기」 · 「가입 신청 중」 → 「승인 대기」, 사유 필터(select) → 검색어 입력, 사유 열은 문장 그대로
③ 설정 LNB 10장(MA-061 · 063 · 070 · 081~087)에 「플랫폼 정보」(MA-088) 항목 추가 — 외부 서비스 연동 다음
사용: gen-board-sync5.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리> (canvas.json 은 현재 publish 된 사본)"""
import sys, pathlib, json, math
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text()
def wr(f, s): (out / f).write_text(s); print('wrote', f, len(s))

# ── ① PF-009 상태 변형(공개 화면 · 해요체) — PF-007-4 의 상태 블록 틀을 따른다
s = rd('PF-009.dc.html')
assert '<div class="states"' not in s
states = ('<div class="states" style="padding: 0 64px 40px; background: transparent; box-shadow: none; grid-template-columns: repeat(2, minmax(0, 1fr))">'
          '<span class="states-h">상태 변형</span>'
          '<div class="st"><span class="st-tag">아직 준비 중이에요 · 서버에 글이 없을 때</span><div class="col" style="width: 100%; text-align: left; gap: 10px">'
          '<div class="msg msg-info" style="width: 100%; flex-direction: column; align-items: flex-start; gap: 4px"><div><b>개인정보처리방침을 아직 준비 중이에요</b></div><div>준비되면 이 페이지에서 바로 볼 수 있어요. 궁금한 점은 고객센터로 물어봐 주세요.</div></div>'
          '<span class="t-c1 c-alt">왼쪽 목차 · 「이전 버전」 · 「내려받기」 버튼은 보이지 않아요 · 바닥글의 「개인정보처리방침」 링크는 그대로 이 화면으로 와요</span></div></div>'
          '<div class="st"><span class="st-tag">로딩</span><div class="col" style="width: 100%; text-align: left; gap: 10px">'
          '<div class="sk" style="height: 28px; width: 40%"></div><div class="sk" style="height: 14px; width: 90%"></div><div class="sk" style="height: 14px; width: 75%"></div></div></div>'
          '</div>\n')
s = rep(s, '</article></div></section>\n  <footer', '</article></div></section>\n  ' + states + '  <footer')
wr('PF-009.dc.html', s)

# ── ② MA-026 1단계 승인
s = rd('MA-026.dc.html')
s = rep(s, '<div class="sum" style="grid-template-columns: repeat(5, 1fr)"><div><div class="k">검토 대기</div><div class="v">3</div></div><div><div class="k">승인 대기 (최고관리자)</div><div class="v">1</div></div>',
        '<div class="sum" style="grid-template-columns: repeat(4, 1fr)"><div><div class="k">승인 대기 (최고관리자)</div><div class="v">4</div></div>')
s = rep(s, '<span class="sp">사유 <select class="i w-m"><option selected>전체</option><option>중복 결제</option><option>잔여 일할</option><option>장애 보상</option><option>의도치 않은 결제</option><option>기타</option></select></span>',
        '<span class="sp"><input class="i w-l" type="text" value="" placeholder="파트너스 · 사유 검색"></span>')
s = rep(s, '<span class="tag y">가입 신청 중</span>', '<span class="tag bl">승인 대기</span>')
s = rep(s, '<span class="tag bl">검토 대기</span>', '<span class="tag bl">승인 대기</span>', 3)
s = rep(s, '필요한 권한: 환불 처리', '필요한 권한: 환불 승인 (최고관리자)')
s = rep(s, '<div class="note inf" style="width: 100%">조회 전용 권한입니다', '<div class="note inf" style="width: 100%">승인은 최고관리자만 할 수 있습니다 · 조회 전용 권한입니다')
wr('MA-026.dc.html', s)

# ── ③ 설정 LNB 「플랫폼 정보」
for f in ['MA-061', 'MA-063', 'MA-070', 'MA-081', 'MA-082', 'MA-083', 'MA-084', 'MA-085', 'MA-086', 'MA-087']:
    s = rd(f + '.dc.html')
    assert 'MA-088.dc.html' not in s, f
    s = rep(s, '외부 서비스 연동</a><div class="lnb-h">관리자</div>', '외부 서비스 연동</a><a class="" href="MA-088.dc.html">플랫폼 정보</a><div class="lnb-h">관리자</div>')
    wr(f + '.dc.html', s)

# ── canvas.json 보드 높이(실제 렌더 + 20 을 10 단위 올림, 커질 때만) — 값은 렌더 후 채운다
c = json.loads(rd('canvas.json'))
c['boards']['MA-026.dc.html']['title'] = c['boards']['MA-026.dc.html']['title'].replace('검토', '승인') if '검토' in c['boards']['MA-026.dc.html']['title'] else c['boards']['MA-026.dc.html']['title']
for k, h in json.loads(pathlib.Path(sys.argv[3]).read_text()).items() if len(sys.argv) > 3 else []:
    want = math.ceil((h + 20) / 10) * 10
    if c['boards'][k]['h'] < want: print('height', k, c['boards'][k]['h'], '->', want); c['boards'][k]['h'] = want
wr('canvas.json', json.dumps(c, ensure_ascii=False, indent=2) + '\n')
print('done')
