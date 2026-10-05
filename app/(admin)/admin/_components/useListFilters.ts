"use client";

import { useEffect, useMemo, useState } from "react";
import { useUrlState } from "../../../../lib/client/navigation";

// 관리자 목록의 「적용된 조건」을 주소 쿼리로 둔다(UX-03, docs/IA.md 「Back · 상태 보존 규칙」 3항). 검색 상자에 쓰는 중인 값(draft)은 화면 안에만 둔다.
// 상세 → Back이나 새로고침에서 조건이 그대로 돌아오고, 바뀐 주소(Back·링크)는 draft에도 반영한다. 기본값(빈 문자열)은 주소에서 빠진다.
export function useListFilters<T extends Record<string, string>>(empty: T) {
  const [url, setUrl] = useUrlState(empty);
  const key = JSON.stringify(url);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const applied = useMemo(() => url, [key]);
  const [draft, setDraft] = useState<T>(applied);
  useEffect(() => setDraft(applied), [applied]);
  return { applied, draft, setDraft, apply: (next: T) => setUrl(next) } as const;
}
