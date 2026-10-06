# 인수 세션 복원 방법

1. 최신 main과 인계 브랜치 `docs/onq-master-handoff-01a10187`를 fetch하고 [마스터 인계 문서](../ONQ_MASTER_HANDOFF_20261006.md), [checkpoint](agent-checkpoints.md), [inventory](worktree-inventory.json)를 읽습니다.
2. feature refs 및 `wip/*-20261006` refs의 실제 SHA를 확인합니다. remote feature의 검증된 SHA와 WIP의 준비 상태를 섞지 않습니다.
3. 같은 `/workspace`가 보이면 기존 dirty worktree를 그대로 보존하며 파일 소유를 인수합니다. 별도 실행 환경이면 해당 작업의 inventory `localHead`에 새 독립 worktree를 만들고 `working-tree/<원래 worktree>/tracked.patch`를 `git apply --check` 후 적용합니다. `untracked/` 아래 파일은 같은 상대 경로로 복사합니다. 이것은 WIP 복원이며 새 코드 테스트 통과를 뜻하지 않습니다.
4. `SHA256SUMS`는 이 폴더에서 `sha256sum -c SHA256SUMS`로 검증합니다. inventory의 `archive` 목록은 미커밋 변경의 보존 위치입니다. 테스트 생성물과 원본 source를 구분합니다.
5. `pr-bodies/`는 당시 실제 본문 초안입니다. 최신 checkpoint 및 현재 테스트 결과에 맞춰 갱신한 뒤 기존 규칙으로 PR을 생성합니다.
6. `references/`는 독립 검수·상태 draft·source mapping·미적용 디자인 제안입니다. 미적용 제안을 main 정책·FINAL·캔버스 완료로 읽지 않습니다.

이 자료에는 인증값, `.env`, `node_modules`, `.next`, 운영 DB 덤프를 넣지 않았습니다. 역할 위임과 별도로 새 실행 환경의 인증·네트워크·실행 권한은 실제 사용할 수 있는 상태인지 확인합니다. 기존 helper의 비밀값을 출력하거나 Git에 옮기지 않습니다.
