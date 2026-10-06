#!/usr/bin/env python3
"""DRAFT→FINAL 묶음 1 (SA-023 · SA-029 · SA-100 · SA-130 · SA-140) 현대화 기준 정리.
사용: gen-final-batch1.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>
입력은 캔버스 아티팩트에서 읽은 최신 사본이어야 한다(저장소 사본 금지)."""
import sys, re, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)

def dates(s):
    # 「10/2 14:10」 「09/30 15:00」 → 「2026.10.02 14:10」 (일시 표기 규칙)
    return re.sub(r'(?<![\d/.])(\d{1,2})/(\d{1,2}) (\d\d:\d\d)', lambda m: '2026.%02d.%02d %s' % (int(m.group(1)), int(m.group(2)), m.group(3)), s)

def unsm_outside_td(s, labels):
    """표 행(td) 밖의 .b.sm 버튼을 40(.b)으로. labels: 대상 글자."""
    pat = re.compile(r'<button class="b sm((?: [a-z]+)*)"([^>]*)>([^<]*)</button>')
    res, pos, hit = [], 0, set()
    for m in pat.finditer(s):
        before = s[:m.start()]
        in_td = before.rfind('<td') > before.rfind('</td>')
        res.append(s[pos:m.start()])
        if in_td or m.group(3) not in labels:
            res.append(m.group(0))
        else:
            res.append('<button class="b%s"%s>%s</button>' % (m.group(1), m.group(2), m.group(3))); hit.add(m.group(3))
        pos = m.end()
    res.append(s[pos:])
    assert hit == set(labels), ('못 찾음', set(labels) - hit)
    return ''.join(res)

# --- SA-023 취소 · 환불 처리 ---
a = (src / 'SA-023.dc.html').read_text()
a = dates(a)
a = unsm_outside_td(a, {'다시 시도'})
(out / 'SA-023.dc.html').write_text(a)

# --- SA-029 교환 · 반품 ---
b = (src / 'SA-029.dc.html').read_text()
b = dates(b)
b = unsm_outside_td(b, {'거절 확정','반송 · 거절','금액 조정 환불','다시 시도','입고 확인','승인 · 수거 접수','환불 실행','재입고 뒤 발송','환불로 전환'})
b = rep(b, '<th style="width: 160px">주문 · 회원</th>', '<th class="l" style="width: 170px">주문 · 회원</th>')
b = rep(b, '<th>상품</th>', '<th class="l">상품</th>', 3)
b = rep(b, '<th style="width: 200px">사유</th>', '<th class="l" style="width: 200px">사유</th>')
b = rep(b, '<th>사유</th>', '<th class="l">사유</th>')
b = rep(b, '<th>내용</th>', '<th class="l">내용</th>')
b = rep(b, '<th>항목</th>', '<th class="l">항목</th>', 2)
b = rep(b, '<th style="width: 110px">요청일</th>', '<th style="width: 130px">요청일</th>')
(out / 'SA-029.dc.html').write_text(b)

# --- SA-100 직원 계정 ---
c = (src / 'SA-100.dc.html').read_text()
c = dates(c)
c = rep(c, '비활성 · 9/15', '비활성 · 09.15')
c = unsm_outside_td(c, {'저장','저장하고 다시 연결 안내'})
# 폼 표(.ft) 안 묶음 선택 버튼은 40
c = rep(c, '<button class="b sm" type="button">방송만</button>', '<button class="b" type="button">방송만</button>')
c = rep(c, '<button class="b sm" type="button">운영 전체</button>', '<button class="b" type="button">운영 전체</button>')
c = rep(c, '<span class="nt">/ 5명</span>', '<span class="nt">전체 5명</span>')
c = rep(c, '<th style="width: 110px">마지막 로그인</th>', '<th style="width: 140px">마지막 로그인</th>')
c = rep(c, '<th style="width: 220px">이름 · 이메일</th>', '<th class="l" style="width: 220px">이름 · 이메일</th>')
# 확인 창 [취소][실행]
for lab in ('저장', '재설정', '비활성화'):
    pat = re.compile(r'(<button class="b pri(?: neg)?" type="button">%s</button>)(<button class="b ?" type="button">취소</button>)' % lab)
    assert len(pat.findall(c)) == 1, lab
    c = pat.sub(lambda m: m.group(2) + m.group(1), c)
c = rep(c, '오버레이 편집', '방송 화면 편집', 3)
c = rep(c, '오버레이 설정 · 주소', '방송 화면 설정 · 주소')
c = rep(c, '오버레이 주소 재발급 안내 받기', '방송 화면 주소 다시 만들기 안내 받기')
assert '오버레이' not in c
(out / 'SA-100.dc.html').write_text(c)

# --- SA-130 알림 센터 ---
d = (src / 'SA-130.dc.html').read_text()
d = rep(d, '<button class="b sm" type="button">모두 읽음</button>', '<button class="b" type="button">모두 읽음</button>')
d = rep(d, '오버레이 재연결됨', '방송 화면 다시 연결됨')
d = rep(d, 'PG 연결을 확인해 주십시오', '카드 결제 연결을 확인해 주십시오')
d = re.sub(r'(<span class="tag[^"]*">)PG(</span>)', r'\1결제\2', d, count=1)
assert 'PG' not in d, [m.start() for m in re.finditer('PG', d)]
(out / 'SA-130.dc.html').write_text(d)

# --- SA-140 도우미 ---
e = (src / 'SA-140.dc.html').read_text()
e = unsm_outside_td(e, {'HIT 카드 등록','결제 연결 오류','내 도메인 연결','다시 보내기','방송 화면 연결하기','적립금 실제 지급 켜기','직원 권한 나누기'})
e = rep(e, 'HIT 카드 등록', 'HIT 카드 기록하기')
e = rep(e, '주소를 다시 발급했다면', '주소를 다시 만들었다면')
e = rep(e, '방송 화면가 OBS에서 안 보입니다', '방송 화면이 OBS에서 안 보입니다')
(out / 'SA-140.dc.html').write_text(e)
print('ok')
