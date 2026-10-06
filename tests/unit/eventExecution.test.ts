import { describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";
vi.mock("node:crypto", { spy: true });
import { allocateExecutionSettings, executeEventSnapshot, executionSnapshotOf, normalizeExecutionSettings, previewEventExecution, type ExecutionSnapshot } from "../../lib/server/events/execution";
import { replayLadder } from "../../lib/server/events/ladder";
const base: ExecutionSnapshot = { kind: "RANDOM_DRAW", winnerCount: 2, settings: { allowDuplicateWinners: false }, entrantIds: ["a", "b", "c"] };
describe("공통 frozen 회차 실행 adapter", () => {
  it.each(["RANDOM_DRAW", "ROULETTE_PARTICIPANT"] as const)("%s는 동일확률·이전당첨자제외·중복금지다", kind => {
    const output = executeEventSnapshot({ ...base, kind, previousWinnerIds: ["a"] });
    expect(output.kind).toBe(kind); expect(new Set(output.draw!.selectedIds)).toEqual(new Set(["b", "c"]));
  });
  it("항목 룰렛은 서버 발급 항목 ID를 선택하며 참가자 명단을 쓰지 않는다", () => {
    const settings = allocateExecutionSettings(normalizeExecutionSettings("ROULETTE_ITEM", { items: ["같은 라벨", "같은 라벨"] }));
    expect(settings.items![0].id).not.toBe(settings.items![1].id);
    const output = executeEventSnapshot({ ...base, kind: "ROULETTE_ITEM", settings, previousWinnerIds: [settings.items![0].id], winnerCount: 1 });
    expect(output.draw!.selectedIds).toEqual([settings.items![1].id]);
  });
  it("명시 중복허용은 이전 당첨 후보도 복원추출한다", () => {
    const output = executeEventSnapshot({ ...base, entrantIds: ["a"], previousWinnerIds: ["a"], winnerCount: 3, settings: { allowDuplicateWinners: true } });
    expect(output.draw!.selectedIds).toEqual(["a", "a", "a"]);
  });
  it("사다리 구조와 실제 결과는 저장 구조의 replay와 동일하다", () => {
    const output = executeEventSnapshot({ ...base, kind: "LADDER", settings: { allowDuplicateWinners: false, outcomeSlots: ["x", "y", "z"].map(id => ({ id, label: id })) } });
    expect(replayLadder(output.ladder!.structure)).toEqual(output.ladder);
    expect(new Set(output.ladder!.routes.map(route => route.outcomeSlotId))).toEqual(new Set(["x", "y", "z"]));
  });
  it("미리보기는 후보·규칙만 반환하며 난수를 호출하지 않는다", () => {
    const rng = vi.mocked(randomInt); rng.mockClear();
    try {
      expect(previewEventExecution({ ...base, previousWinnerIds: ["a"] }).candidateIds).toEqual(["b", "c"]);
      previewEventExecution({ ...base, kind: "LADDER", settings: { allowDuplicateWinners: false, outcomeSlots: ["x", "y", "z"].map(id => ({ id, label: id })) } });
      expect(rng).not.toHaveBeenCalled();
    } finally { rng.mockClear(); }
  });
  it("후보부족과 사다리 슬롯불일치를 명시 오류로 거부한다", () => {
    expect(() => previewEventExecution({ ...base, previousWinnerIds: ["a", "b"] })).toThrow("not_enough_candidates");
    expect(() => previewEventExecution({ ...base, kind: "LADDER", settings: { allowDuplicateWinners: false, outcomeSlots: [] } })).toThrow("ladder_slot_count_mismatch");
  });
  it("라벨과 실행 설정은 엄격 검증하며 사다리 중복허용을 추론하지 않는다", () => {
    expect(() => normalizeExecutionSettings("LADDER", { outcomeSlots: ["당첨"], allowDuplicateWinners: true })).toThrow("invalid_event_rules");
    expect(() => normalizeExecutionSettings("RANDOM_DRAW", { items: ["항목"] })).toThrow("invalid_event_rules");
    expect(() => normalizeExecutionSettings("ROULETTE_ITEM", { items: [" "] })).toThrow("invalid_event_rules");
  });
  it("기존 v1 회차는 읽으며 frozen 규칙 없는 결과는 거부한다", () => {
    expect(executionSnapshotOf({ version: 1, kind: "RANDOM_DRAW", winnerCount: 1 }, ["a"]).settings.allowDuplicateWinners).toBe(false);
    expect(() => executionSnapshotOf({ version: 2, kind: "RANDOM_DRAW", winnerCount: 1 }, ["a"])).toThrow("invalid_frozen_rules");
  });
});
