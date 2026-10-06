#!/usr/bin/env python3
"""DRAFT→FINAL 묶음 2 (SA-005 · SA-013 · SA-024 · SA-002-O · SH-009 · SH-030 · SH-041 · AU-008) 현대화 기준 정리.
사용: gen-final-batch2.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리> (입력은 캔버스 아티팩트 사본)"""
import sys, re, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)
def dates(s):  # 「10/2 14:10」 「10/2」 「2026-10-02」 → 「2026.10.02 …」
    s = re.sub(r'(?<![\d/.])2026-(\d\d)-(\d\d)', r'2026.\1.\2', s)
    return re.sub(r'(?<![\d/.])(\d{1,2})/(\d{1,2})(?![\d/])', lambda m: '2026.%02d.%02d' % (int(m.group(1)), int(m.group(2))), s)
def unsm(s, labels):
    pat = re.compile(r'<(button|a) class="b sm((?: [a-z]+)*)"([^>]*)>([^<]*)</(button|a)>')
    res, pos, hit = [], 0, set()
    for m in pat.finditer(s):
        res.append(s[pos:m.start()])
        if m.group(4) in labels:
            res.append('<%s class="b%s"%s>%s</%s>' % (m.group(1), m.group(2), m.group(3), m.group(4), m.group(5))); hit.add(m.group(4))
        else: res.append(m.group(0))
        pos = m.end()
    res.append(s[pos:]); assert hit == set(labels), set(labels) - hit
    return ''.join(res)

# SA-005 쇼핑몰 통합 전환
s = (src / 'SA-005.dc.html').read_text()
s = dates(s)
s = unsm(s, {'오버레이 전용으로 변경 신청', '변경 취소', '조회'})
for a, b in (('변경 신청', '취소'), ('변경 취소', '유지')):
    pat = re.compile(r'(<button class="b pri(?: neg)?" type="button">%s</button>)(<button class="b ?" type="button">%s</button>)' % (a, b))
    assert len(pat.findall(s)) == 1, (a, b); s = pat.sub(lambda m: m.group(2) + m.group(1), s)
# 결제 구조(2026-10-05 대표님 결정): 플랫폼 결제대행사 키 하나, 파트너스별 PG 연결 없음
s = rep(s, '구매자 결제는 파트너스 명의 PG로 직접 받습니다 · 이 계좌는 환불 · 정산 확인에 씁니다', '구매자 결제는 ONQ 결제대행사로 받습니다 · 이 계좌는 정산 · 환불 확인에 씁니다')
s = rep(s, '지금 바로 상품 등록과 PG 연결을 할 수 있습니다', '지금 바로 상품을 등록할 수 있습니다')
assert 'PG' not in s
(out / 'SA-005.dc.html').write_text(s)

# SA-013 상품 상세 미리보기
s = (src / 'SA-013.dc.html').read_text()
s = unsm(s, {'쇼핑몰에서 열기', '복사'})
(out / 'SA-013.dc.html').write_text(s)

# SA-024 영수증 · 세금계산서
s = (src / 'SA-024.dc.html').read_text()
s = rep(s, '<input class="i w-s" type="text" value="2026-10-02" placeholder="">', '<input class="i w-s dt" type="text" value="2026.10.02" placeholder="">', 2)
s = dates(s)
s = rep(s, '<th>비고</th>', '<th class="l">비고</th>')
(out / 'SA-024.dc.html').write_text(s)

# SA-002-O 홈 · 오버레이 전용 (「오버레이 전용」은 예외, 나머지 「오버레이」→「방송 화면」)
s = (src / 'SA-002-O.dc.html').read_text()
s = unsm(s, {'다시 연결', '구독 시작하기', '자동 연결로 고치기', '완료 설정 확인'})
pat = re.compile(r'(<button class="b pri" type="button">요금제 안내 보기</button>)(<button class="b ?" type="button">닫기</button>)')
assert len(pat.findall(s)) == 1; s = pat.sub(lambda m: m.group(2) + m.group(1), s)
s = rep(s, '오버레이 편집기', '방송 화면 편집기')
s = rep(s, '<div class="k">오버레이</div>', '<div class="k">방송 화면</div>')
s = rep(s, 'OBS 오버레이를 설정했습니다', 'OBS 방송 화면을 설정했습니다')
s = rep(s, '방송 · 오버레이 · 외부 쇼핑몰 연동만', '방송 · 방송 화면 · 외부 쇼핑몰 연동만')
s = rep(s, '결제(PG)', '결제')
s = rep(s, '10/2 (금) 21:12 기준', '2026.10.02 21:12 기준')
s = rep(s, '(10/9 (금)까지)', '(2026.10.09까지)')
s = rep(s, '10/1 자동 연결로', '2026.10.01 자동 연결로')
assert not re.search(r'오버레이(?! 전용)', s), re.findall(r'.{20}오버레이(?! 전용).{20}', s)
(out / 'SA-002-O.dc.html').write_text(s)

# SH-009 · SH-009-PC · SH-041: 변경 없음(틀 · 문구 확인만) → 그대로 복사
for f in ('SH-009', 'SH-009-PC', 'SH-041'):
    (out / f'{f}.dc.html').write_text((src / f'{f}.dc.html').read_text())

# SH-030 · SH-030-PC 공지 · 이용안내: 날짜 연월일
for f in ('SH-030', 'SH-030-PC'):
    s = (src / f'{f}.dc.html').read_text(); s2 = dates(s); assert s2 != s
    (out / f'{f}.dc.html').write_text(s2)

# AU-008 권한 없음
s = (src / 'AU-008.dc.html').read_text()
s = unsm(s, {'파트너스 관리자로'})
(out / 'AU-008.dc.html').write_text(s)
print('ok')
