#!/usr/bin/env python3
"""보드 반영 묶음 27 — 휴대폰(390) 보드 5단계 (UI_STATUS 「휴대폰(390) 보드 제안」 순서 5, MASTER (4) 승인 2026-10-06 · MASTER (5) 재가동 지시 2026-10-16).
MA-002 알림 센터 · MA-100 실시간 감시 · MA-120 인프라 · 비용 · MA-013-OPS 가입 신청(MA-013 정본) — 각 PC 정본(1920) 안에 「휴대폰 390」 상태 변형 블록을 추가한다.
범위(제안 순서 5): 마스터 관리자는 PC 중심 · 휴대폰은 알림에서 바로 열리는 「조회 · 승인 · 자동 연결 결제 잠시 막기」까지만. 그래서 390 블록은
요약 타일 · 목록 카드(DS-TABLE-CARD, SA-021-M 규격) · 긴급 창만 담고, 상세 검색 · 일괄 처리 · 설정 입력 · 긴 기록 표는 PC로 둔다(블록 안 안내문 한 줄).
내용(숫자 · 문구 · 상태 · 버튼 이름)은 PC 정본의 표 행에서 그대로 읽어 카드로 옮긴다. 새 정보 · 새 CTA 없음. 틀은 .c24.mob(SA-FRAME-M)와 같고 색만 .ma(마스터 관리자).
새 파일 · canvas.json 변경 없음. 사용: gen-board-sync27.py <design/project 디렉터리> (제자리 수정 · 다시 돌리면 표식 <!-- m390 --> 사이 블록을 지우고 새로 만든다)"""
import re, sys, pathlib
src = pathlib.Path(sys.argv[1])

def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def rd(f): return (src / f).read_text(encoding='utf-8')
def wr(f, s): (src / f).write_text(s, encoding='utf-8'); print('wrote', f, len(s))
def strip(h): return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', h)).strip()
def cells(row):
    return [m.group(1) for m in re.finditer(r'<td[^>]*>(.*?)</td>', row, re.S)]
def rows(t, after):
    i = t.index('<tbody>', t.index(after)); j = t.index('</tbody>', i)
    return re.findall(r'<tr>(.*?)</tr>', t[i:j], re.S)
def tags(h):  # 태그 배지는 그대로, 글은 버린다
    return ''.join(re.findall(r'<span class="tag[^"]*">[^<]*</span>', h))

TOP = ('<div class="top"><button class="mn" type="button" aria-label="메뉴"><i></i><i></i><i></i></button><a class="brand" href="MA-001.dc.html">'
       '<span class="logo-sym" style="--brand: #fff; --brand-ink: var(--c24-gnb)"></span>ONQ <small>마스터 관리자</small></a>'
       '<a class="bell" href="MA-002.dc.html" aria-label="알림 센터">알림<em>4</em></a></div>')
def mph(h1, path, acts=''):
    return f'<div class="mph"><h1>{h1}</h1><span class="path">{path}</span>{("<div class=\"acts\">" + acts + "</div>") if acts else ""}</div>'
def kv(k, v): return f'<div class="m-kv"><b>{k}</b><span>{v}</span></div>'
def card(title, small, tag, kvs, acts=''):
    return (f'<div class="m-card"><div class="hd"><div class="nm"><a href="#">{title}</a><small>{small}</small></div>{tag}</div>'
            f'<div class="m-kvs">{"".join(kvs)}</div>' + (f'<div class="ac">{acts}</div>' if acts else '') + '</div>')
def tiles(items):  # 요약 타일 2열 — PC .sum 과 같은 k/v 구조
    return '<div class="sum" style="grid-auto-flow: row; grid-template-columns: 1fr 1fr">' + ''.join(f'<div><div class="k">{k}</div><div class="v">{v}</div></div>' for k, v in items) + '</div>'
def frame(h1, path, body, cap, acts='', h=1500):
    return ('<div class="st" style="grid-column: 1 / -1"><span class="st-tag">휴대폰 390</span>'
            f'<div class="app c24 ma mob" data-theme="light" style="width: 390px; margin: 0 auto; text-align: left"><div class="m-ph" style="width: 390px; min-height: {h}px">'
            + TOP + mph(h1, path, acts) + f'<div class="body"><div class="note inf" style="width: 100%">{cap}</div>' + body + '</div></div></div></div>')
MARK_A, MARK_B = '<!-- m390 -->', '<!-- /m390 -->'
def strip_prev(t):
    """이전 실행이 남긴 「휴대폰 390」 블록(표식 사이)을 지워 다시 돌려도 결과가 같게 한다."""
    while MARK_A in t:
        a = t.index(MARK_A); b = t.index(MARK_B, a) + len(MARK_B); t = t[:a] + t[b:]
    return t
def add_state(t, block, old_h, new_h):
    t = strip_prev(t)
    t = rep(t, '</div>\n</div>\n</x-dc>', MARK_A + block + MARK_B + '</div>\n</div>\n</x-dc>')
    return re.sub(r'"height":\d+', f'"height":{new_h}', t, count=1)

# ---------- MA-002 알림 센터 ----------
t = strip_prev(rd('MA-002.dc.html'))
cards = []
for r in rows(t, '<table class="lt">'):
    c = cells(r)  # [체크, 심각도, 유형, 파트너스, 내용, 발생, 담당, 상태, 관리]
    body_txt = strip(re.sub(r'<div class="nt">.*?</div>', '', c[4])); sub = strip(''.join(re.findall(r'<div class="nt">(.*?)</div>', c[4])))
    partner = strip(re.sub(r'<span class="tag[^"]*">[^<]*</span>', '', c[3])); live = tags(c[3])
    cards.append(card(f'{strip(c[2])} · {partner}', f'{body_txt}' + (f' · {sub}' if sub else ''), c[1] + live,
                      [kv('발생', strip(c[5])), kv('담당', strip(c[6]) or '—'), kv('상태', c[7])],
                      '<button class="b sm" type="button">담당</button><button class="b sm" type="button">대신 보기</button>'))
chips = ('<div class="chips" style="overflow-x: auto; white-space: nowrap; display: flex; gap: 6px; padding: 4px 0"><button class="chip on" type="button">미처리 <span class="n">4</span></button>'
         '<button class="chip" type="button">처리 중 <span class="n">2</span></button><button class="chip hot" type="button">긴급</button><button class="chip" type="button">주의</button><button class="chip" type="button">정보</button><button class="chip" type="button">전체 <span class="n">21</span></button></div>')
# 상세 검색은 PC 전용(블록 안 안내문) — 휴대폰 출력에 상세 검색 링크를 두지 않는다(Codex 리뷰 2026-10-17)
body = chips + '<div class="m-cards">' + ''.join(cards) + '</div><div class="pg2"><a href="#" class="b">‹ 이전</a><a href="#" class="b">다음 ›</a></div>'
t = add_state(t, frame('알림 센터', '홈 › 알림 센터', body, '휴대폰에서는 알림 확인 · 담당 · 대신 보기까지 합니다 · 모두 확인 처리 · 채널 설정 · 알림 규칙 요약은 PC에서', '', 2200), 1300, 4800)
wr('MA-002.dc.html', t)

# ---------- MA-100 실시간 감시 ----------
t = strip_prev(rd('MA-100.dc.html'))
sum_items = re.findall(r'<div><div class="k">(.*?)</div><div class="v">(.*?)</div></div>', t[t.index('<div class="sum'):t.index('<div class="sec-t">장애')], re.S)
cards = []
for r in rows(t, '<div class="sec-t">장애'):
    c = cells(r)  # [시각, 심각도, 대상, 내용, 자동 조치, 상태]
    cards.append(card(strip(c[2]), strip(c[3]), c[1] + c[5], [kv('시각', strip(c[0])), kv('자동 조치', strip(c[4]))]))
cfm = ('<div class="cfm" style="max-width: none; width: 100%"><div class="h">결제 검증이 5분째 실패합니다.<button class="x" type="button" aria-label="닫기">×</button></div>'
       '<div class="bd">자동으로 풀리지 않았습니다. 자동 연결 결제를 잠시 막으시겠습니까?<div class="nt" style="margin-top: 6px">알림톡 · 메일로 알렸습니다 16:04</div></div>'
       '<div class="f" style="flex-direction: column; gap: 8px"><button class="b pri neg" type="button" style="width: 100%">자동 연결 결제 잠시 막기</button><button class="b " type="button" style="width: 100%">10분 더 지켜보기</button></div></div>')
body = ('<div class="note neg" style="width: 100%"><b>긴급 1</b> · 결제 검증 지연 4.8초(임계 2초) · 사람 판단 필요</div>' + cfm + tiles(sum_items)
        + '<div class="sec-t">장애 · 이상 목록<span class="nt">긴급 · 주의 · 정보</span></div><div class="m-cards">' + ''.join(cards) + '</div>')
t = add_state(t, frame('실시간 감시', '운영 › 실시간 감시', body, '휴대폰에서는 상태 확인과 긴급 창의 「자동 연결 결제 잠시 막기」까지 합니다 · 자동 조치 기록 · 안전 규칙 · 결제 결과 확인 대기 · 자동으로 도는 작업 표는 PC에서', '<button class="b " type="button">지금 갱신</button>', 2300), 1250, 4800)
wr('MA-100.dc.html', t)

# ---------- MA-120 인프라 · 비용 ----------
t = strip_prev(rd('MA-120.dc.html'))
sum_items = re.findall(r'<div><div class="k">(.*?)</div><div class="v">(.*?)</div></div>', t[t.index('<div class="sum'):t.index('<div class="sec-t">용량')], re.S)
cards = []
for r in rows(t, '<th style="width: 200px">서버</th>'):
    c = cells(r)  # [서버, 디스크, 메모리, CPU, 상태, 마지막 보고, 비고]
    name = strip(re.sub(r'<div class="nt">.*?</div>', '', c[0])); spec = strip(''.join(re.findall(r'<div class="nt">(.*?)</div>', c[0])))
    pct = lambda h: strip(re.sub(r'<span class="gg[^"]*">.*?</span>', '', h))
    cards.append(card(name, spec, c[4], [kv('디스크', pct(c[1])), kv('메모리', pct(c[2])), kv('CPU', pct(c[3])), kv('마지막 보고', strip(c[5]))] + ([kv('비고', strip(c[6]))] if strip(c[6]) else [])))
body = ('<div class="note inf" style="width: 100%">최고관리자만 볼 수 있습니다 · 휴대폰에서는 조회만</div>' + tiles(sum_items)
        + '<div class="sec-t">용량 · 서버<span class="nt">80% 경고 · 90% 위험</span></div><div class="m-cards">' + ''.join(cards) + '</div>')
t = add_state(t, frame('인프라 · 비용', '운영 › 인프라 · 비용', body, '휴대폰에서는 상태 · 용량 · 요금 조회까지 합니다 · 정리 실행 · 만료일 저장 · 단가 입력 · 데이터베이스 · 저장소 · 외부 연결 · 요금 표는 PC에서', '<button class="b " type="button">지금 새로고침</button>', 2100), 2600, 5600)
wr('MA-120.dc.html', t)

# ---------- MA-013-OPS 가입 신청 ----------
t = strip_prev(rd('MA-013-OPS.dc.html'))
sum_items = re.findall(r'<div><div class="k">(.*?)</div><div class="v">(.*?)</div></div>', t[t.index('<div class="sum'):t.index('<div class="chips">')], re.S)
cards = []
for r in rows(t, '<table class="lt">'):
    c = cells(r)  # [체크, 쇼핑몰·신청자, 사업자, 업종, 신청일·경과, 확인, 상태, 관리]
    shop = strip(re.sub(r'<div class="nt">.*?</div>', '', c[1])); who = strip(''.join(re.findall(r'<div class="nt">(.*?)</div>', c[1])))
    when = strip(re.sub(r'<span class="ago[^"]*">.*?</span>', '', c[4])); ago = strip(''.join(re.findall(r'<span class="ago[^"]*">(.*?)</span>', c[4])))
    acts = re.findall(r'<(?:button|a) class="b sm[^"]*"[^>]*>([^<]*)</(?:button|a)>', c[7])
    ac = ''.join(('<button class="b sm pri" type="button">승인</button>' if a == '승인' else
                  '<button class="b sm pri" type="button">확인할 내용 보기</button>' if a == '확인할 내용 보기' else
                  '<a class="b sm" href="MA-014.dc.html">상세</a>' if a == '상세' else '') for a in acts)
    cards.append(card(shop, f'{who} · {strip(c[3])}', c[6], [kv('신청', when), kv('경과', ago or '—'), kv('사업자', strip(c[2])), kv('확인', strip(c[5]))], ac))
chips_src = t[t.index('<div class="chips">'):t.index('</div>', t.index('<div class="chips">')) + 6]
# PC 전용 「상세 검색 펼치기」 버튼(과 빈 .sp 묶음)은 휴대폰 칩 줄에서 뺀다 — 상세 검색은 PC(블록 안 안내문) (Codex 리뷰 2026-10-17)
chips_src = rep(chips_src, '<button class="b sm" type="button">상세 검색 펼치기</button>', '')
chips_src = re.sub(r'<span class="sp"[^>]*>\s*</span>', '', chips_src)
assert '상세 검색' not in chips_src
body = (tiles(sum_items) + chips_src.replace('<div class="chips">', '<div class="chips" style="overflow-x: auto; white-space: nowrap; display: flex; gap: 6px; padding: 4px 0">')
        + '<div class="m-cards">' + ''.join(cards) + '</div><div class="pg2"><a href="#" class="b">‹ 이전</a><a href="#" class="b">다음 ›</a></div>')
t = add_state(t, frame('가입 신청', '파트너스 › 가입 신청', body, '휴대폰에서는 조회 · 건별 승인 · 상세까지 합니다 · 반려(사유 창) · 선택 일괄 승인 · 보완 요청 · 상세 검색은 PC에서', '', 2600), 2950, 6800)
wr('MA-013-OPS.dc.html', t)
print('done')
