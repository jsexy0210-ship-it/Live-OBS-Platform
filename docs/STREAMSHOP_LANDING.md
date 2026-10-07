# 스트림샵 랜딩 PF-001

기준일: 2026-10-07 KST. 대표님 지시: 「랜딩 화면도 Streamlabs를 벤치마킹해서 거의 비슷하게 만들되, 우리 스타일로 적용한다」.

## 적용

- 경로: `/about`. 기존 `/` 로그인 경로와 가입/로그인/요금/기능 경로 유지.
- 참조: https://streamlabs.com/ultra · https://streamlabs.com/ko-kr/ultra · https://streamlabs.com/plugin-for-obs . 앞선 공개 페이지 조사에서 확인한 가치 제안→기능→제품 사용 장면→플랜 비교→FAQ→가입 흐름을 적용한다.
- 브랜드: 스트림샵 / StreamShop, 승인한 S·재생 버튼 심볼을 배경 제거해 사용. 인디고 #4F46E5, 민트 #80E8C1, 잉크 #171A24, 클라우드 #F7F8FC. 심볼 파일은 `public/branding/streamshop-symbol.png`이며 Next Image로 제공한다.
- 기존 방송 프로그램을 사용하는 판매자를 위해 내 쇼핑몰·오버레이·주문대기·방송 이후 운영을 소개한다. Streamlabs 문구·테마·제품 화면을 복사하지 않는다.
- 방송 화면·주문 카드·상품 그래픽은 샘플 예시로 명시했다. 고객 사용량이나 실적 수치는 넣지 않았다.
- 서버 `getPublicPlan`의 가격·플랜 이름·체험 일수만 표시한다. API/DB 실패·가입 가능 플랜 없음은 별도 안내한다. 플랜별 체험 CTA를 구분하고, 결제대행/발송 등 별도 비용을 안내한다.
- 마케팅 페이지의 장식용 예시에 조작 가능한 것처럼 보이는 가짜 버튼을 두지 않는다. 가입·로그인·기능·요금·공지·약관 링크는 기존 경로를 사용한다. FAQ는 native details/summary다.
- 모바일에서도 요금과 FAQ를 제공한다. 키보드 포커스·본문 바로가기·reduced-motion 규칙을 포함한다.

## 소스

- 구현: `components/public/Landing.tsx`, `Landing.module.css`.
- 서버 경로/메타데이터: `app/(public)/about/page.tsx`.
- 디자인 변경 정본: `design/project/PF-001.dc.tsx`, `PF-001.module.css`. 별도 사본이며 production이 정본 코드를 import하지 않는다.
- 디자인 미리보기: `npm run design:preview` 후 `/landing`. 샘플 가격은 문서 기준 예시이고 실제 요금은 서버 조회 결과를 따른다.
- 기존 `PF-001.dc.html` 및 캔버스 기록은 이전 디자인 참조로 보존한다.

## 완료와 남은 일

- 완료: 랜딩·반응형 스타일·메타데이터·심볼 자산·디자인 소스·미리보기 경로 작성.
- 미실행: 테스트, 브라우저 렌더 대조, 1440/1024/390 스크린샷, 외부 캔버스 동기화.
- main 병합과 배포는 별도이며, 소스 작성으로 운영 반영을 주장하지 않는다.
- 브랜드 이름 전면 교체와 파트너스/마스터 화면 개편은 이 랜딩 변경에 포함하지 않았다.
