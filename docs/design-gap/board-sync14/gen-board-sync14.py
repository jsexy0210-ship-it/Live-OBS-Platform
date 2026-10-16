#!/usr/bin/env python3
"""보드 반영 묶음 14 — 대표님 지시 2026-10-06 「파트너스 쇼핑몰 가입 시 디폴트 값 지정해놔 · 플레이스홀더도 다 기입해」(MASTER (4) 전달).
파트너스 관리자 보드(design/project/SA-*.dc.html) 전체에서 placeholder="" 인 입력칸을 찾아 예시 문구를 채운다.
규칙(MASTER): 실제 쓸 법한 구체 예시 · 파트너스 화면 말투(명사형 · 합니다체) · AI 같은 문구 · 코드성 표기 · 과장 · 없는 값 금지.
판단 순서: 파일별 예외 → 라벨 사전 → 비밀번호 → 날짜 · 기간 · 색 → 숫자(금액 · 수량 · 비율 · 일수) → 문맥 → 남는 것은 보고.
결과 목록은 placeholders.md 로 같이 쓴다(화면 세션이 구현에 그대로 반영).
사용: gen-board-sync14.py <아티팩트 사본 project/ 디렉터리> <출력 디렉터리>"""
import sys, pathlib, re, glob, os
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

LABEL = {
    '이름': '이름', '대표자명': '대표자 이름', '상호': '사업자등록증의 상호', '사업자등록번호': '000-00-00000',
    '통신판매업 신고번호': '통신판매업 신고번호', '사업장 주소': '주소 검색', '계좌번호': '숫자만', '예금주': '예금주 이름',
    '휴대폰 번호': '010-0000-0000', '휴대폰번호': '010-0000-0000', '이메일 (로그인 아이디)': 'name@example.com', '이메일': 'name@example.com',
    '초기 비밀번호': '8자 이상 · 영문과 숫자', '현재 비밀번호': '현재 비밀번호', '새 비밀번호': '8자 이상 · 영문과 숫자', '새 비밀번호 확인': '새 비밀번호 다시 입력',
    '송장번호': '송장번호 숫자 10~14자리', '제목': '제목', '검색 제목': '검색 결과에 보일 제목 (60자)', '공유 제목': '공유 카드 제목 (60자)',
    '공유 설명': '공유 카드 설명 한 줄', '카카오톡 채널 주소': '카카오톡 채널 주소', '유튜브 채널 주소': '유튜브 채널 주소',
    '상단 공지 (한 줄)': '상단 공지 한 줄', '검색 도구 소유 확인 코드': '검색 도구에서 받은 확인 코드', '메모 (파트너스만)': '메모 (파트너스만 봅니다)',
    '상품명': '상품명 입력', '쿠폰 이름': '쿠폰 이름', '등급 이름': '등급 이름', '상품 코드': '상품 코드', '방송 제목': '방송 제목 (선택)',
    '짧은 설명': '한 줄 설명', '카드명': '카드 이름', '사유 메모': '사유', '띠 문구': '문구 입력', '줄 문구': '문구 입력', '본문': '문구 입력',
    '비어 있을 때': '문구 입력', '제목 (대체 텍스트)': '이미지 설명', '상품 주소': '주소 뒷부분 (영문 · 숫자 · -)', '검색어': '상품명 · 상품 코드',
    '자동 구매 확정 기간': '일수 (1~30)', '자동 배송 완료 기간': '일수', '배송비': '0', '반품 배송비 (편도)': '0', '최대 할인 (비율만)': '0',
    '쿠폰 삭제': '영문 · 숫자 4~12자', '등장 시간': '0', '표시 시간': '0', '세로 티커': '0', '위치': '0', '입금 기한': '0',
}
CTX = [('공유 제목', '공유 카드 제목 (60자)'), ('옵션명', '0'), ('상품명을 입력해 주십시오', '상품명 입력'), ('값 지정', '0'),
       ('재고', '0'), ('이름 *', '이름')]
DATE = re.compile(r'^\d{4}[-.]\d{2}[-.]\d{2}$'); DT = re.compile(r'^\d{4}[-.]\d{2}[-.]\d{2} \d{2}:\d{2}$'); RANGE = re.compile(r'^\d{4}[-.]\d{2}[-.]\d{2}.*~')
NUM = re.compile(r'^-?[\d,]+(\.\d+)?$'); COLOR = re.compile(r'^#[0-9A-Fa-f]{3,8}$')

OV = {('SA-001-DK', ''): '메모 입력', ('SA-001', '다시 불러오기'): '메모 입력', ('SA-012-E', '×'): '옵션명', ('SA-012-E', '판매'): '판매 단위',
      ('SA-051-C', '대기 영역 상품색이 배경과 2.8:1입니다.'): '문구 입력', ('SA-052', '세로형 1080×1920 (9:16)'): '방송 화면 주소',
      ('SA-052', '가로형 1920×1080 (16:9)'): '방송 화면 주소', ('SA-052', '이 주소는 지금만 볼 수 있습니다.'): '방송 화면 주소',
      ('SA-057', '채팅 가져오기 잠시 멈춤'): '유튜브 방송 주소', ('SA-060', '연결할 주소'): 'shop.example.com', ('SA-060', '운영 시간'): '평일 10:00 ~ 18:00',
      ('SA-066', '질문'): '질문', ('SA-080', '알림톡 발신 프로필이 없습니다.'): '문구 입력', ('SA-060', '쇼핑몰 이름'): '쇼핑몰 이름',
      ('SA-060', '한 줄 소개'): '한 줄 소개 (60자)', ('SA-060', '대표자'): '대표자 이름', ('SA-060', '고객센터 연락처'): '02-000-0000',
      ('SA-012', '삭제'): '옵션명', ('SA-012-DK', '삭제'): '옵션명'}

def decide(f, typ, val, cls, label, before, after):
    if NUM.match(val) and label != '검색어': return '0'
    if COLOR.match(val): return '#000000'
    if ' dt' in cls or DT.match(val): return '일시 선택' if (DT.match(val) or '시' in label) else '날짜 선택'
    if RANGE.match(val): return '기간 선택'
    if DATE.match(val): return '날짜 선택'
    if (f[:-8], label) in OV: return OV[(f[:-8], label)]
    if typ == 'password': return LABEL.get(label, '8자 이상')
    if label in LABEL: return LABEL[label]
    if re.match(r'^\s*<span class="unit">', after): return '0'
    for key, ph in CTX:
        if key in before[-200:]: return ph
    if val.startswith('[') and val.endswith(']'): return val[1:-1]
    if val: return None
    return None

rows, left = [], []
for f in sorted(glob.glob(str(src / 'SA-*.dc.html'))):
    name = os.path.basename(f); s = open(f, encoding='utf-8').read()
    def sub(m):
        attrs = m.group(2) + m.group(3)
        typ = (re.search(r'type="([^"]*)"', attrs) or [None, 'text'])[1]
        val = (re.search(r'value="([^"]*)"', attrs) or [None, ''])[1]
        cls = (re.search(r'class="([^"]*)"', attrs) or [None, ''])[1]
        before = re.sub(r'<svg.*?</svg>', '', s[max(0, m.start() - 600):m.start()], flags=re.S)
        labs = [l.strip() for l in re.findall(r'<(?:th|label|b|span class="k")[^>]*>([^<]{1,40})<', before) if l.strip()]
        label = labs[-1] if labs else ''
        ph = decide(name, typ, val, cls, label, before, s[m.end():m.end() + 60])
        if ph is None:
            left.append((name, label, val)); return m.group(0)
        rows.append((name, label or '(라벨 없음)', val, ph))
        return f'<{m.group(1)}{m.group(2)}placeholder="{ph}"{m.group(3)}>'
    s2 = re.sub(r'<(input|textarea)([^>]*)placeholder=""([^>]*)>', sub, s)
    if s2 != s:
        (out / name).write_text(s2);
print('filled', len(rows), 'left', len(left))
for l in left: print('LEFT', l)
md = ['# 파트너스 입력칸 placeholder 목록 (묶음 14 · 대표님 지시 2026-10-06)', '', '정본 보드에 채운 예시 문구. 화면 세션은 같은 화면 · 같은 칸에 이 문구를 그대로 쓴다. 값이 들어 있는 칸은 비었을 때 보이는 문구다.', '',
      '| 보드 | 칸(라벨) | 보드 예시 값 | placeholder |', '|---|---|---|---|']
md += [f'| {n[:-8]} | {l} | {v} | {p} |' for n, l, v, p in rows]
(out / 'placeholders.md').write_text('\n'.join(md) + '\n')
