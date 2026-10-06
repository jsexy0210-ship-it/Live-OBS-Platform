import { afterEach, describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import { drawEqualChance, previewEqualChanceDraw, type DrawInput } from "../../lib/server/events/draw";

vi.mock("node:crypto", { spy: true });

const base: DrawInput = { candidateIds: ["a", "b", "c"], winnerCount: 2, allowDuplicateWinners: false };
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

function sequence(values: number[]) {
  let cursor = 0;
  return vi.fn((_max: number) => {
    if (cursor >= values.length) throw new Error("Unexpected random call");
    return values[cursor++];
  });
}

describe("equal-chance server draw", () => {
  it("uses node CSPRNG by default with exclusive bounds", () => {
    const rng = vi.mocked(crypto.randomInt).mockImplementationOnce(() => 2).mockImplementationOnce(() => 0);
    expect(drawEqualChance(base).selectedIds).toEqual(["c", "a"]);
    expect(rng.mock.calls).toEqual([[3], [2]]);
  });

  it("previews pool and rules without drawing or consuming randomness", () => {
    const rng = vi.mocked(crypto.randomInt);
    const input = { ...base, previousWinnerIds: ["c"] };
    const preview = previewEqualChanceDraw(input);
    expect(preview.eligibleCandidateIds).toEqual(["a", "b"]);
    expect(Object.keys(preview).sort()).toEqual(["eligibleCandidateIds", "rules"]);
    expect(rng).not.toHaveBeenCalled();
    const drawn = drawEqualChance(input, sequence([0, 0]));
    expect(drawn.rules).toEqual(preview.rules);
  });

  it("selects without replacement and preserves remaining candidate order", () => {
    const rng = sequence([1, 0]);
    expect(drawEqualChance(base, rng)).toEqual({
      selectedIds: ["b", "a"], eligibleCandidateIds: ["a", "b", "c"], remainingCandidateIds: ["c"],
      rules: { winnerCount: 2, allowDuplicateWinners: false, excludePreviousWinners: true,
        excludedIds: [], sampling: "WITHOUT_REPLACEMENT", probability: "EQUAL" },
    });
    expect(rng.mock.calls).toEqual([[3], [2]]);
  });

  it("samples with replacement, allowing more winners than candidates", () => {
    const rng = sequence([1, 1, 0, 1]);
    const result = drawEqualChance({ ...base, winnerCount: 4, allowDuplicateWinners: true }, rng);
    expect(result.selectedIds).toEqual(["b", "b", "a", "b"]);
    expect(result.remainingCandidateIds).toEqual(base.candidateIds);
    expect(result.rules.sampling).toBe("WITH_REPLACEMENT");
    expect(rng.mock.calls).toEqual([[3], [3], [3], [3]]);
  });

  it.each([false, true])("applies explicit exclusions, previous winners depend on duplication=%s", allowDuplicateWinners => {
    const result = drawEqualChance({ ...base, winnerCount: 1, allowDuplicateWinners,
      previousWinnerIds: ["a", "past"], excludedIds: ["c", "past"] }, sequence([0]));
    expect(result.eligibleCandidateIds).toEqual(allowDuplicateWinners ? ["a", "b"] : ["b"]);
    expect(result.rules.excludedIds).toEqual(allowDuplicateWinners ? ["c", "past"] : ["c", "past", "a"]);
    expect(result.rules.excludePreviousWinners).toBe(!allowDuplicateWinners);
  });

  it("excludes saved winners from the next round", () => {
    const first = drawEqualChance({ ...base, winnerCount: 1 }, sequence([1]));
    const next = drawEqualChance({ ...base, previousWinnerIds: first.selectedIds }, sequence([1, 0]));
    expect(next.selectedIds).toEqual(["c", "a"]);
    expect(next.remainingCandidateIds).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid count %s before randomness", winnerCount => {
    const rng = vi.fn();
    expect(() => drawEqualChance({ ...base, winnerCount }, rng)).toThrow(RangeError);
    expect(rng).not.toHaveBeenCalled();
  });

  it.each([
    { candidateIds: [] }, { candidateIds: ["a", "a"] }, { candidateIds: [""] },
    { previousWinnerIds: ["a", "a"] }, { excludedIds: ["a", "a"] },
    { excludedIds: [" "] }, { previousWinnerIds: [""] },
    { excludedIds: ["a", "b", "c"] }, { previousWinnerIds: ["a", "b", "c"] },
    { winnerCount: 4 },
  ])("rejects invalid candidates/exclusions %# before randomness", patch => {
    const rng = vi.fn();
    expect(() => drawEqualChance({ ...base, ...patch }, rng)).toThrow();
    expect(rng).not.toHaveBeenCalled();
  });

  it("rejects malformed input and predetermined or weighted fields", () => {
    const rng = vi.fn();
    const malformed: unknown[] = [null, {}, { ...base, candidateIds: "abc" }, { ...base, excludedIds: "a" }, { ...base, excludedIds: null }, { ...base, previousWinnerIds: null },
      { ...base, previousWinnerIds: [1] }, { ...base, allowDuplicateWinners: "false" },
      { ...base, selectedIds: ["a"] }, { ...base, weights: [10, 1, 1] }, { ...base, seed: 1 }];
    for (const input of malformed) expect(() => drawEqualChance(input as DrawInput, rng)).toThrow();
    expect(rng).not.toHaveBeenCalled();
  });

  it.each([-1, 3, 0.5, NaN, Infinity])("rejects out-of-range injected random index %s", index => {
    expect(() => drawEqualChance(base, () => index)).toThrow("Invalid random index");
  });

  it("enumerates every equal-probability permutation exactly once without replacement", () => {
    const counts = new Map<string, number>();
    for (let first = 0; first < 3; first++) for (let second = 0; second < 2; second++) {
      const result = drawEqualChance({ ...base, winnerCount: 3 }, sequence([first, second, 0]));
      expect(new Set(result.selectedIds).size).toBe(3);
      const key = result.selectedIds.join("");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // Each independent random path has probability 1/3 * 1/2 * 1 = 1/6.
    expect([...counts.keys()].sort()).toEqual(["abc", "acb", "bac", "bca", "cab", "cba"]);
    expect([...counts.values()]).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("enumerates all equally likely ordered pairs with replacement", () => {
    const counts = new Map<string, number>();
    for (let first = 0; first < 3; first++) for (let second = 0; second < 3; second++) {
      const key = drawEqualChance({ ...base, allowDuplicateWinners: true }, sequence([first, second])).selectedIds.join("");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // Each independent random path has probability 1/3 * 1/3 = 1/9, including repeated IDs.
    expect([...counts.keys()].sort()).toEqual(["aa", "ab", "ac", "ba", "bb", "bc", "ca", "cb", "cc"]);
    expect([...counts.values()]).toEqual(Array(9).fill(1));
  });

  it.each([false, true])("does not mutate or alias any input arrays with duplication=%s", allowDuplicateWinners => {
    const input = Object.freeze({ candidateIds: Object.freeze(["item-1", "item-2", "item-3"]),
      previousWinnerIds: Object.freeze(["item-1"]), excludedIds: Object.freeze(["item-3"]),
      winnerCount: 1, allowDuplicateWinners });
    const before = JSON.stringify(input);
    const result = drawEqualChance(input, sequence([0]));
    result.selectedIds.push("changed");
    result.remainingCandidateIds.push("changed");
    result.eligibleCandidateIds.push("changed");
    result.rules.excludedIds.push("changed");
    expect(JSON.stringify(input)).toBe(before);
    expect(result.remainingCandidateIds).not.toBe(result.eligibleCandidateIds);
  });
});
