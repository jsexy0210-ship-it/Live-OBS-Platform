import { describe, expect, it } from "vitest";
import { timelineText } from "../../components/seller/automation/common";

// 작업 기록(SA-152) 한 줄 문구. 서버 timelineKind가 내보내는 종류는 모두 자기 문구가 있어야 한다(없으면 「진행 중입니다」로 잘못 보임).
describe("timelineText", () => {
  it("단계 완료는 단계 번호와 이름으로 보인다", () => {
    expect(timelineText({ at: "2026-10-06T00:00:00Z", kind: "step_done", stepNumber: 1, reason: null })).toBe("1단계(다른 쇼핑몰 이어 주기) 완료");
    expect(timelineText({ at: "2026-10-06T00:00:00Z", kind: "step_done", stepNumber: null, reason: null })).toBe("단계를 마쳤습니다");
  });
  it("서버가 내보내는 종류마다 「진행 중입니다」가 아닌 문구가 있다", () => {
    const kinds = ["payment_confirmed", "started", "needs_customer", "resumed", "verifying", "retry", "paused", "continued", "step_done", "succeeded", "failed", "canceled", "cleanup_needed"];
    for (const kind of kinds) expect(timelineText({ at: "2026-10-06T00:00:00Z", kind, stepNumber: 2, reason: null }), kind).not.toBe("진행 중입니다");
  });
  it("모르는 종류는 일반 문구", () => {
    expect(timelineText({ at: "2026-10-06T00:00:00Z", kind: "other", stepNumber: null, reason: null })).toBe("진행 중입니다");
  });
});
