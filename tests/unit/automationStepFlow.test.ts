import { describe, expect, it } from "vitest";
import { stepFlow } from "../../lib/server/automation/admin";
import { STEPS } from "../../lib/server/automation/steps";

const states = (idx: number, status: string) => stepFlow(idx, status).map((s) => s.state);
const N = STEPS.length;

describe("자동 연결 작업 흐름 표(MA-111)", () => {
  it("진행 중은 앞 단계 완료·현재 단계 진행 중·뒤 단계 대기", () => {
    expect(states(2, "RUNNING")).toEqual(STEPS.map((_, i) => (i < 2 ? "done" : i === 2 ? "current" : "pending")));
    expect(states(2, "NEEDS_CUSTOMER")[2]).toBe("current");
    expect(states(2, "VERIFYING")[2]).toBe("current");
  });
  it("결제 대기·대기열에 있는 단계는 진행 중으로 보이지 않는다", () => {
    expect(states(0, "AWAITING_PAYMENT").every((s) => s === "pending")).toBe(true);
    expect(states(1, "QUEUED")[1]).toBe("pending");
  });
  it("성공이면 전부 완료, 실패·취소·정리 필요는 멈춘 단계를 stopped로", () => {
    expect(states(N - 1, "SUCCEEDED").every((s) => s === "done")).toBe(true);
    for (const st of ["FAILED", "CANCELED", "CLEANUP_NEEDED"]) {
      const r = states(1, st);
      expect(r[0]).toBe("done");
      expect(r[1]).toBe("stopped");
      expect(r.slice(2).every((s) => s === "pending")).toBe(true);
    }
  });
  it("단계 키·종류는 steps.ts 그대로", () => {
    expect(stepFlow(0, "RUNNING").map((s) => [s.key, s.kind])).toEqual(STEPS.map((s) => [s.key, s.kind]));
  });
});
