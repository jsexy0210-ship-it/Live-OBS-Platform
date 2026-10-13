#!/usr/bin/env python3
"""보드 반영 묶음 15 — placeholder 전수 기입 2차(대표님 지시 2026-10-06 「플레이스홀더도 다 기입해」 · 묶음 14 후속).
묶음 14는 placeholder="" 인 칸만 채웠고, placeholder 속성 자체가 없는 textarea 22 · 입력 2 가 남아 있어 채운다(파일별 등장 순서로 지정 · 건수 assert).
파트너스 화면 말투 명사형 · 합니다체. 구매자에게 보이는 글(재입고 안내 · 답변 · 공지 · 이용안내 · 알림톡)은 해요체 예시.
사용: gen-board-sync15.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>"""
import sys, pathlib, re
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
SKIP = ('checkbox', 'radio', 'hidden', 'file', 'range', 'color', 'button', 'submit')
PH = {
    'SA-012.dc.html': ['0', '0'],
    'SA-017.dc.html': ['「상품명」이 다시 들어왔어요. 수량이 적으니 서둘러 주세요.'],
    'SA-022.dc.html': ['주문 처리 메모 (파트너스 · 직원만 봅니다)'],
    'SA-023-R.dc.html': ['구매자에게 보이는 거절 사유'],
    'SA-047.dc.html': ['구매자에게 보일 답변 (해요체)'],
    'SA-048.dc.html': ['리뷰에 남길 답글'],
    'SA-049.dc.html': ['알림 본문 (쇼핑몰 이름 · (광고) 표시는 자동으로 붙습니다)'],
    'SA-055.dc.html': ['방송 메모 (파트너스만 봅니다)'],
    'SA-060.dc.html': ['개봉 전 주문은 취소할 수 있어요. 개봉하면 단순 변심으로는 취소 · 환불이 안 돼요.'],
    'SA-062.dc.html': ['약관 본문 (표준 약관 불러오기 또는 직접 입력)'],
    'SA-065.dc.html': ['팝업 본문 (해요체)'],
    'SA-066.dc.html': ['구매자에게 보일 답변 (해요체)', '공지 본문 (해요체)'],
    'SA-067.dc.html': ['검색 결과에 보일 설명 (160자)'],
    'SA-080.dc.html': ['알림 문구 · 변수 {닉네임} {순번} 사용'] * 6,
    'SA-090-M.dc.html': ['남기고 싶은 말 (선택)'],
    'SA-114.dc.html': ['무슨 일이 있었는지, 언제 생겼는지 적어 주십시오'],
    'SA-115.dc.html': ['추가로 궁금한 내용을 적어 주십시오'],
}
rows = []
for name, phs in PH.items():
    s = (src / name).read_text(); it = iter(phs); n = 0
    def sub(m):
        global n
        a = m.group(2); t = re.search(r'type="([^"]*)"', a)
        t = t.group(1) if t else ('textarea' if m.group(1) == 'textarea' else 'text')
        if t in SKIP or 'placeholder=' in a: return m.group(0)
        ph = next(it); n += 1
        before = re.sub(r'<svg.*?</svg>', '', s[max(0, m.start() - 500):m.start()], flags=re.S)
        labs = [l.strip() for l in re.findall(r'<(?:th|label|b|span class="k"|div class="sec-t"|h2)[^>]*>([^<]{1,40})<', before) if l.strip()]
        rows.append((name[:-8], labs[-1] if labs else '(라벨 없음)', ph))
        return f'<{m.group(1)}{a} placeholder="{ph}">'
    s2 = re.sub(r'<(input|textarea)\b([^>]*)>', sub, s)
    assert n == len(phs), (name, n, len(phs))
    (out / name).write_text(s2); print('wrote', name, n)
md = ['', '## 2차 (묶음 15 · placeholder 속성이 없던 textarea · 입력 24칸)', '', '| 보드 | 칸(라벨) | placeholder |', '|---|---|---|'] + [f'| {n} | {l} | {p} |' for n, l, p in rows]
(out / 'placeholders-2.md').write_text('\n'.join(md) + '\n')
