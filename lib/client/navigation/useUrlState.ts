"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { markNextReplace } from "./NavigationTracker";

/**
 * 목록 조건(검색어·필터·정렬·페이지 크기·탭)을 URL 쿼리와 동기화한다(history는 쌓지 않는다).
 * 기본값과 같은 값은 쿼리에서 뺀다. 상세 → Back에서 조건이 그대로 돌아온다.
 */
export function useUrlState<T extends Record<string, string>>(defaults: T) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const values = { ...defaults } as Record<string, string>;
  for (const k of Object.keys(defaults)) values[k] = params.get(k) ?? defaults[k];

  const set = useCallback(
    (patch: Partial<T>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === defaults[k]) next.delete(k);
        else next.set(k, v as string);
      }
      const qs = next.toString();
      if (qs === params.toString()) return;
      markNextReplace();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, pathname, params],
  );

  return [values as T, set] as const;
}
