import { useMemo, useRef } from "react";

// 같은 자료를 여러 번 다시 읽을 때(화면 이동·포커스·저장 직후 등) 응답 반영 규칙:
// - 이미 반영한 것보다 나중에 보낸 요청의 성공 응답만 반영한다(늦게 온 옛 응답이 새 값을 덮지 않게)
// - 나중에 보낸 요청이 실패해도 먼저 보낸 요청의 성공은 버리지 않는다(세대는 성공을 반영할 때 확정)
// - 파생 값은 accept가 true일 때 같은 자리에서 함께 계산한다
// 검색어·필터처럼 요청마다 조건이 다른 목록은 해당하지 않는다(그때는 마지막으로 보낸 조건의 응답만 맞다).
export function useLatestResponse() {
  const sent = useRef(0);
  const applied = useRef(0);
  return useMemo(
    () => ({
      // 요청을 보내기 직전에 부른다: 이 요청의 세대
      next: () => ++sent.current,
      // n세대 요청의 성공 응답을 반영해도 되는지. true면 세대를 확정한다
      accept: (n: number) => {
        if (n <= applied.current) return false;
        applied.current = n;
        return true;
      },
      // 성공 응답을 한 번이라도 반영했는지(아직 그린 적 없으면 실패 화면을 보인다)
      hasApplied: () => applied.current > 0,
    }),
    [],
  );
}
