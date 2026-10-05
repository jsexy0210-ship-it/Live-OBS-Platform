"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { canGoBackWithin } from "./NavigationTracker";

/**
 * 화면 ← 버튼·「목록」·「취소」용. 앱 안 이전 화면(같은 영역, 인증 화면 아님)이 있으면 router.back(),
 * 없으면(직접 진입·새로고침·다른 영역) 부모 경로로 replace한다.
 */
export function useSmartBack(fallback: string): () => void {
  const router = useRouter();
  return useCallback(() => {
    if (canGoBackWithin(fallback)) router.back();
    else router.replace(fallback);
  }, [router, fallback]);
}
