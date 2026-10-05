"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { confirmLeave, useSmartBack } from "../../lib/client/navigation";
import { canGoBackWithin } from "../../lib/client/navigation/NavigationTracker";

// 상세·하위 화면의 「목록」·「취소」·「이전」 버튼. 앱 안 이전 화면이 있으면 그리로(목록 조건·스크롤 유지),
// 직접 진입이면 부모 경로로 replace(docs/IA.md Back 규칙 1항, docs/BACK_ROUTES.md).
// dirty(저장 안 한 변경)는 화면이 useUnsavedGuard(dirty)를 함께 쓸 때만 넘긴다: 이전 화면으로 가는 경우는 그 도우미의 popstate 확인이
// 한 번 묻고, 부모로 replace하는 경우(popstate 없음)만 여기서 묻는다.
export function SmartBackButton({ fallback, className = "btn btn-out", dirty = false, children }: { fallback: string; className?: string; dirty?: boolean; children: ReactNode }) {
  const router = useRouter();
  const back = useSmartBack(fallback);
  const onClick = () => {
    if (dirty && canGoBackWithin(fallback)) return router.back();
    if (confirmLeave(dirty)) back();
  };
  return (
    <button type="button" className={className} onClick={onClick}>
      {children}
    </button>
  );
}
