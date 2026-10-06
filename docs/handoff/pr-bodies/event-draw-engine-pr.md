## 변경
참가자 추첨과 룰렛 항목 선정을 함께 사용할 서버 전용 `drawEqualChance`를 추가했습니다. `node:crypto.randomInt`로 모든 후보에 같은 확률을 적용합니다. 중복 금지 시 복원 없이 추첨하고 이전 당첨자를 제외하며, 중복 허용 시 복원 추첨합니다. 명시적 제외 대상은 항상 제외합니다.

난수를 소비하지 않는 `previewEqualChanceDraw`는 실행 전 후보·규칙을 제공합니다. 실행 결과는 선정 ID, 실행 전 후보, 남은 후보, 적용 규칙만 반환합니다. 후보 스냅숏 동결·결과 저장 뒤 애니메이션을 재생하도록 서버 호출 계약을 명시했습니다. 가중치·구매 확률·seed·사전 선정 필드는 허용하지 않습니다.

## 검사
- `npm test -- tests/unit/eventsDraw.test.ts`: 33건 통과. CSPRNG 호출 범위, 복원/비복원, 이전 당첨 제외, 입력 검증, 후보 3명의 모든 6개 순열/9개 복원 순서, 미리보기 난수 미소비, 입력 불변성을 확인했습니다.
- `npm run typecheck`: 통과(종료 코드 0).
- `npm run build`: 통과(종료 코드 0, 343 static pages 생성). 초기 외부 node_modules symlink 거부는 worktree 내 dependency 복사로 해소했습니다. Node randomInt overload에 맞게 시험 mock을 고쳤습니다.
- `git diff --cached --check`: 통과.
- 최신 origin/main `4a06ba90` 병합 확인: Already up to date.

## 미완료·범위
- core service 연결·DB 저장·UI·animation·schema·migration·OBS·문서 변경은 이번 PR 범위 밖입니다. 추후 서버가 검증한 동결 후보를 전달하고 반환 결과를 저장해야 합니다. 난수 주입은 신뢰된 서버 시험 전용이며 요청에서 받으면 안 됩니다.
- 후보 수·당첨 수의 상품별 상한은 호출 서비스가 검증해야 합니다. 유틸리티는 양의 안전 정수와 비복원 후보 수를 검증합니다.
- 실제 결제·보상·배포를 실행하지 않았습니다. 검수 전담 검수 및 병합을 요청합니다.

## 독립 검수·외부 등록 상태
독립 검수에서 집중 시험 33/33 직접 재실행 및 확인된 helper 결함 없음으로 보고했습니다. 열린 PR 24개 head SHA와 fetched refs가 모두 일치하며 신규 소유 2파일 중복이 없음을 재확인했습니다. 정상 인증 helper로 `feat/event-draw-engine` push를 완료했고 원격 HEAD는 `2ec66a798ea7c1fe89516ab1187d6a202d49e6d1`로 확인했습니다. `api.github.com` 네트워크 차단으로 PR 생성은 아직 불가능합니다. 우회하지 않았으며 PR·CI는 생성되지 않았습니다.
