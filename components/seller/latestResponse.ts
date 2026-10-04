import { useMemo, useRef } from "react";

// 같은 자료를 여러 번 다시 읽을 때(화면 이동·포커스·저장 직후 등) 응답 반영 규칙:
// - 이미 반영한 것보다 나중에 보낸 요청의 성공 응답만 반영한다(늦게 온 옛 응답이 새 값을 덮지 않게)
// - 나중에 보낸 요청이 실패해도 먼저 보낸 요청의 성공은 버리지 않는다(세대는 성공을 반영할 때 확정)
// - 화면이 서버가 확정한 변경을 직접 반영했으면(confirmChange) 그 전에 보낸 요청의 응답은 전체를 덮지 않는다("outdated")
// - 실패도 같은 세대 규칙을 따른다: 이미 반영한 응답보다 먼저 보낸 요청의 실패는 알리지 않는다(failMatters)
// - 파생 값은 "apply"일 때 같은 자리에서 함께 계산한다
// 검색어·필터처럼 요청마다 조건이 다른 목록은 해당하지 않는다(그때는 마지막으로 보낸 조건의 응답만 맞다).
export type ReadTicket = { n: number; change: number };
export type ReadVerdict = "apply" | "older" | "outdated";

export function useLatestResponse() {
  const sent = useRef(0);
  const applied = useRef(0);
  const change = useRef(0);
  return useMemo(
    () => ({
      // 요청을 보내기 직전에 부른다: 이 요청의 세대와 그때까지 확정된 변경 번호
      next: (): ReadTicket => ({ n: ++sent.current, change: change.current }),
      // 성공 응답을 반영해도 되는지. "apply"면 세대를 확정한다.
      // "older": 이미 더 나중 응답을 반영함 · "outdated": 보낸 뒤에 확정된 변경이 있어 이 응답으로 덮으면 그 변경이 사라짐
      accept: (t: ReadTicket): ReadVerdict => {
        if (t.n <= applied.current) return "older";
        if (t.change < change.current) return "outdated";
        applied.current = t.n;
        return "apply";
      },
      // 실패한 요청을 화면에 알려야 하는지: 이미 반영한 성공보다 나중에 보낸 요청의 실패만 의미가 있다
      failMatters: (t: ReadTicket) => t.n > applied.current,
      // 서버가 성공으로 확정한 변경을 화면에 직접 반영했을 때 부른다
      confirmChange: () => {
        change.current += 1;
      },
      // 지금까지 확정된 변경 번호("outdated"일 때 다시 읽기를 한 번만 요청하는 데 쓴다)
      changes: () => change.current,
      // 성공 응답을 한 번이라도 반영했는지(아직 그린 적 없으면 실패 화면을 보인다)
      hasApplied: () => applied.current > 0,
    }),
    [],
  );
}
