#!/usr/bin/env python3
"""보드 반영 묶음 2 (MASTER 배정 2026-10-06): SA-150 「소요 시간」 · MA-024 #761 차이 · SH-022 날짜 머리 · SA-114 · MA-052 진단 항목(#778).
사용: gen-board-sync2.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리> (입력은 캔버스 아티팩트 사본)"""
import sys, re, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
def rep(s, old, new, n=1):
    assert s.count(old) == n, (old[:70], s.count(old), n)
    return s.replace(old, new)

# ① SA-150 「소요」 → 「소요 시간」 (#767 구현과 동일)
s = (src / 'SA-150.dc.html').read_text()
s = rep(s, '<th>소요</th>', '<th>소요 시간</th>', 2)
(out / 'SA-150.dc.html').write_text(s)

# ② MA-024 #761 차이: 예정 행 「상세」 → 파트너스 상세(MA-012) · 요금제 「베타」 → 서버 3종(월 구독) · 상태 선택지 5종은 이미 일치
s = (src / 'MA-024.dc.html').read_text()
rows = re.findall(r'<tr>(?:(?!</tr>).)*?<span class="tag bl">예정</span>(?:(?!</tr>).)*?</tr>', s)
assert rows, '예정 행 없음'
n = 0
for r in rows:
    if 'href="MA-025.dc.html">상세</a>' in r:
        s = s.replace(r, r.replace('href="MA-025.dc.html">상세</a>', 'href="MA-012-1.dc.html">파트너스 상세</a>')); n += 1
assert n >= 1, n
s = rep(s, '<option>베타</option>', '<option>월 구독</option>')
assert s.count('<option>결제 완료</option><option>실패 · 재시도</option><option>예정</option><option>환불 완료</option><option>연체</option>') == 1
(out / 'MA-024.dc.html').write_text(s)
print('MA-024 예정 행 링크', n)

# ③ SH-022 · SH-022-PC · SH-022-M 주문 상세 머리 날짜 → 연월일(2026.10.02 20:41)
for f in ('SH-022', 'SH-022-PC', 'SH-022-M'):
    s = (src / f'{f}.dc.html').read_text()
    s2 = re.sub(r'(?<![\d/.])10/2 (20:4[18])', r'2026.10.02 \1', s)
    assert s2 != s, f
    assert not re.search(r'(?<![\d/.])\d{1,2}/\d{1,2} \d\d:\d\d', s2), f
    (out / f'{f}.dc.html').write_text(s2)

# ④ SA-114 진단 정보: 실제 항목(#778)만 · 보낼지 여부 1개(includeDiagnostics)
s = (src / 'SA-114.dc.html').read_text()
old = ('<tr><th>함께 보낼 진단 정보 (자동)</th><td><label class="ck"><input type="checkbox" name="r" checked>방송 화면 접속 기록 · 최근 연결 로그 (24시간)</label>'
       '<label class="ck"><input type="checkbox" name="r" checked>브라우저 · OBS 버전</label>'
       '<label class="ck"><input type="checkbox" name="r" checked>최근 결제대행사 응답 코드 (결제 연결 종류일 때)</label></td></tr>')
new = ('<tr><th>함께 보낼 진단 정보</th><td><label class="ck"><input type="checkbox" name="r" checked>진단 정보를 함께 보냅니다</label>'
       '<span class="hint">보낼 때 한 번 모읍니다 · 브라우저 · OS · OBS 버전 · 최근 방송 · 방송 화면 마지막 접속 · 앱 버전 · 확인할 수 없는 항목은 「확인 안 됨」으로 갑니다</span></td></tr>')
s = rep(s, old, new)
(out / 'SA-114.dc.html').write_text(s)

# ⑤ MA-052 진단 정보: 접속 기록 · 연결 로그 · 결제대행사 응답 코드 · 오버레이 UA 제거, 실제 항목으로
s = (src / 'MA-052.dc.html').read_text()
s = rep(s, '진단 정보를 확인했습니다. 방송 화면 접속 기록에 15:02부터 재연결 시도가 10회 실패한 기록이 있고, 원인은 파트너스님 OBS 브라우저 소스의 URL이 2026.09.29 재발급 이전 주소로 남아 있기 때문입니다.',
        '진단 정보를 확인했습니다. 방송 화면 마지막 접속이 2026.09.29 14:50이고 그 뒤 접속이 없으며, 방송 화면 주소는 2026.09.29에 다시 만들어졌습니다. 파트너스님 OBS 브라우저 소스의 URL이 이전 주소로 남아 있는 것으로 보입니다.')
s = rep(s, '<tr><th>방송 화면</th><td><span class="tag r">재연결 실패 10회</span></td></tr><tr><th>주소 재발급</th><td>2026.09.29 재발급 · OBS 미반영 의심</td></tr>',
        '<tr><th>방송 화면</th><td>마지막 접속 2026.09.29 14:50<br><span class="tag r">그 뒤 접속 없음</span></td></tr><tr><th>주소 다시 만듦</th><td>2026.09.29 · OBS 미반영 의심</td></tr>')
old = ('<div class="sec-t">자동 진단</div><table class="lt"><thead><tr><th style="width: 70px">결과</th><th>내용</th></tr></thead><tbody>'
       '<tr><td><span class="tag r">실패</span></td><td class="l">방송 화면 토큰 불일치 (구 토큰 접속 시도)</td></tr>'
       '<tr><td><span class="tag g">정상</span></td><td class="l">실시간 서버 · 파트너스 지역</td></tr>'
       '<tr><td><span class="tag g">정상</span></td><td class="l">OBS 30.1 · 브라우저 소스 지원</td></tr></tbody></table>')
new = ('<div class="sec-t">진단 정보 <span class="nt">문의를 보낼 때 한 번 모은 값</span></div><table class="ft"><colgroup><col style="width: 150px"><col></colgroup>'
       '<tr><th>브라우저 · OS</th><td>Chrome 130 · Windows 11</td></tr>'
       '<tr><th>OBS 버전</th><td>30.1</td></tr>'
       '<tr><th>최근 방송</th><td>LIVE · 2026.10.02 15:00 시작</td></tr>'
       '<tr><th>방송 화면 마지막 접속</th><td>2026.09.29 14:50</td></tr>'
       '<tr><th>앱 버전</th><td><span class="nt">확인 안 됨</span></td></tr></table>')
s = rep(s, old, new)
s = rep(s, '<td class="l">접수 · 자동 진단</td>', '<td class="l">접수 · 진단 정보 첨부</td>')
for bad in ('접속 기록', '연결 로그', '응답 코드', '자동 진단'):
    assert bad not in s, (bad, [s[m.start()-60:m.start()+60] for m in re.finditer(bad, s)][:2])
(out / 'MA-052.dc.html').write_text(s)

# ⑥ SA-061 배송 설정 「영업일」 → 「일」(서버가 달력 일수로 계산, MASTER 결정)
s = (src / 'SA-061.dc.html').read_text()
s = rep(s, '<span class="unit">영업일</span>', '<span class="unit">일</span>')
s = rep(s, '개봉이 끝나면 2영업일 안에 보내요', '개봉이 끝나면 2일 안에 보내요', 2)
assert '영업일' not in s
(out / 'SA-061.dc.html').write_text(s)

# ⑦ 쇼핑몰 닫힘 화면(SH-040 · SH-040-PC · SH-041): 이용약관 · 개인정보처리방침 · 고객센터는 열려 있음(법정 고지)
for f, old in (('SH-040', '홈 · 상품 · 장바구니 · 회원가입 주소로 들어와도 이 화면이 떠요. 판매자 사정은 적지 않아요.'),
               ('SH-040-PC', '홈 · 상품 · 장바구니 · 회원가입 주소로 들어와도 이 화면이 떠요. 판매자 사정은 적지 않아요.'),
               ('SH-041', '상품 · 홈 · 장바구니 주소로 들어와도 이 화면이 떠요. 판매자 사정은 적지 않아요.')):
    s = (src / f'{f}.dc.html').read_text()
    s = rep(s, old, old + ' 이용약관 · 개인정보처리방침 · 고객센터는 닫혀 있어도 볼 수 있어요.')
    (out / f'{f}.dc.html').write_text(s)

# ⑧ SH-012 · SH-012-PC 비밀번호 찾기: 「가입 안 된 이메일」 상태 삭제(서버는 존재 여부를 드러내지 않음) · 새 비밀번호 힌트 8자 이상
for f in ('SH-012', 'SH-012-PC'):
    s = (src / f'{f}.dc.html').read_text()
    s2 = re.sub(r'<div class="st"><span class="st-tag">가입 안 된 이메일</span>.*?</div></div></div>(?=<div class="st">|\n</div>)', '', s, count=1, flags=re.S)
    assert s2 != s and '가입 안 된' not in s2, f
    s2 = rep(s2, '8자 이상 · 영문과 숫자를 섞어 주세요', '8자 이상')
    s2 = rep(s2, '링크는 30분 동안 쓸 수 있어요 · 메일이 없으면 스팸함을 확인해 주세요', '가입된 이메일이면 재설정 메일이 가요 · 링크는 30분 동안 쓸 수 있어요 · 메일이 없으면 스팸함을 확인해 주세요')
    (out / f'{f}.dc.html').write_text(s2)

# ⑨ SA-064 · SA-065 배너 · 팝업 이미지 형식 「JPG · PNG」 → 「PNG」(대표님 2026-10-04 지시 · 서버 PNG만). SA-066에는 형식 안내 없음
for f, n in (('SA-064', 6), ('SA-065', 5)):
    s = (src / f'{f}.dc.html').read_text()
    s = rep(s, 'JPG · PNG', 'PNG', n)
    assert 'JPG' not in s
    (out / f'{f}.dc.html').write_text(s)
print('ok')
