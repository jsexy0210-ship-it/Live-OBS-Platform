"use client";

import { useEffect, useState } from "react";

// 테스트 서버 모드 안내(대표님 지시 2026-10-03). 서버가 테스트 모드(OBS_TEST_MODE=1)면 GET /api/health에 testMode: true가 붙는다.
// 그 값이 true일 때만 보이고, 운영(값 없음)·조회 실패면 아무것도 보이지 않는다. 한 페이지에서 여러 번 써도 한 번만 묻는다.
let cached: Promise<boolean> | null = null;
function loadTestMode(): Promise<boolean> {
  cached ??= fetch("/api/health", { cache: "no-store" })
    .then((r) => r.json())
    .then((b: { testMode?: unknown }) => b.testMode === true)
    .catch(() => false);
  return cached;
}

export function useTestMode(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadTestMode().then((v) => alive && setOn(v));
    return () => {
      alive = false;
    };
  }, []);
  return on;
}

// kind: identity = 본인확인 단계, payment = 결제 단계
export default function TestModeNotice({ kind }: { kind: "identity" | "payment" }) {
  const on = useTestMode();
  if (!on) return null;
  return (
    <div className="msg msg-info" role="note" data-testid="test-mode-notice">
      <span>{kind === "identity" ? "테스트 모드예요. 인증번호 000000을 입력하세요" : "테스트 모드예요. 실제로 결제되지 않아요"}</span>
    </div>
  );
}
