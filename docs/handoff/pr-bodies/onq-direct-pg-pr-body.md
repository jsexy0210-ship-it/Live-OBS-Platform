## 변경 내용

제품 정본 `docs/PRODUCT_SCOPE.md`의 PG 지원 범위를 Payple(페이플)·NHN KCP 직접 계약·직접 연동으로 한정했습니다. 이전 NICEPAY 후보·공개 요금 비교를 제거하고 계약 조건·수수료·정기결제 지원 조건은 확인 사항으로 남겼습니다. 업체·연결 방식이 미확정이라는 구문은 정본 표를 참조하도록 정리했습니다.

`docs/FEATURE_GAP.md`는 2026-10-02 작성 당시 격차·후보 분석이라는 역사 기록임을 표시했습니다. 현재 PG 정책을 여러 문서에 복제하지 않았습니다.

## 자체 검수

- 최신 main `4a06ba90` fetch·merge: 통과했습니다.
- OPEN24 fetched refs 대조: PRODUCT_SCOPE·FEATURE_GAP·PROJECT_STATUS 변경 겹침 0건입니다.
- `git diff --check`: 통과했습니다.
- 변경 파일 2개·할인 가격 절 동일성 검사: 통과했습니다.
- event scope `4b677623`·launch discount `32199545` 각각과 `git merge-tree --write-tree`: 충돌 없이 통과했습니다. 실제 브랜치 병합은 하지 않았습니다.
- 문서 변경이므로 앱 typecheck·build는 실행하지 않았습니다.

## 미완료·판단 필요

- PG 코드·어댑터·실제 계약·실결제 시험은 변경하거나 실행하지 않았습니다.
- 구독 할인 정책은 기존 launch discount 브랜치가 담당하며 이 PR에 복제하지 않았습니다.
- PROJECT_STATUS 최신화는 저장소 외부 검토 초안을 MASTER에 전달했으며 원본을 수정하지 않았습니다.
