import { describe, expect, it } from "vitest";
import type { QueueItemStatus } from "@prisma/client";
import { checkTransition, isCompletePermutation, isValidTimer, type QueueAction } from "../../lib/server/queue/rules";

const now = new Date("2026-10-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const item = (status: QueueItemStatus, doneAt: Date | null = null) => ({ status, doneAt, inLiveBroadcast: true });
const ctx = { now, hasOtherOpening: false };

describe("상태 전이 표 전체", () => {
  // [전 상태, 동작] → 결과 상태 또는 거부
  const table: [QueueItemStatus, QueueAction, QueueItemStatus | "reject"][] = [
    ["WAITING", "start", "OPENING"],
    ["WAITING", "complete", "reject"],
    ["WAITING", "revert", "reject"],
    ["WAITING", "cancel", "CANCELLED"],
    ["WAITING", "timer", "WAITING"],
    ["OPENING", "start", "reject"],
    ["OPENING", "complete", "DONE"],
    ["OPENING", "revert", "reject"],
    ["OPENING", "cancel", "CANCELLED"],
    ["OPENING", "timer", "OPENING"],
    ["DONE", "start", "reject"],
    ["DONE", "complete", "reject"],
    ["DONE", "revert", "OPENING"],
    ["DONE", "cancel", "reject"],
    ["DONE", "timer", "reject"],
    ["CANCELLED", "start", "reject"],
    ["CANCELLED", "complete", "reject"],
    ["CANCELLED", "revert", "reject"],
    ["CANCELLED", "cancel", "reject"],
    ["CANCELLED", "timer", "reject"],
  ];

  it.each(table)("%s + %s → %s", (from, action, expected) => {
    const r = checkTransition(item(from, from === "DONE" ? ago(1000) : null), action, ctx);
    if (expected === "reject") expect(r).toEqual({ ok: false, reason: "invalid_transition" });
    else expect(r).toEqual({ ok: true, to: expected });
  });
});

describe("개봉 시작 조건", () => {
  it("방송 중이 아닌 항목은 개봉할 수 없다", () => {
    expect(checkTransition({ ...item("WAITING"), inLiveBroadcast: false }, "start", ctx)).toEqual({ ok: false, reason: "not_live" });
  });

  it("다른 「개봉 중」이 있으면 거부", () => {
    expect(checkTransition(item("WAITING"), "start", { now, hasOtherOpening: true })).toEqual({ ok: false, reason: "other_opening" });
  });
});

describe("개봉 완료 되돌리기 (10초)", () => {
  it("완료 후 10초 안이면 허용", () => {
    expect(checkTransition(item("DONE", ago(3_000)), "revert", ctx)).toEqual({ ok: true, to: "OPENING" });
    expect(checkTransition(item("DONE", ago(10_000)), "revert", ctx)).toEqual({ ok: true, to: "OPENING" });
  });

  it("10초가 지나면 거부", () => {
    expect(checkTransition(item("DONE", ago(10_001)), "revert", ctx)).toEqual({ ok: false, reason: "revert_expired" });
  });

  it("다른 「개봉 중」이 있으면 거부", () => {
    expect(checkTransition(item("DONE", ago(1_000)), "revert", { now, hasOtherOpening: true })).toEqual({
      ok: false,
      reason: "other_opening",
    });
  });
});

describe("입력 검증", () => {
  it("타이머는 0~3600 정수", () => {
    expect([0, 30, 3600].every(isValidTimer)).toBe(true);
    expect([-1, 3601, 1.5, "30", null].some(isValidTimer)).toBe(false);
  });

  it("순서 변경은 같은 범위 대기 항목 전체를 중복 없이", () => {
    expect(isCompletePermutation(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
    expect(isCompletePermutation(["a", "b", "c"], ["a", "b"])).toBe(false);
    expect(isCompletePermutation(["a", "b"], ["a", "a"])).toBe(false);
    expect(isCompletePermutation(["a", "b"], ["a", "x"])).toBe(false);
  });
});
