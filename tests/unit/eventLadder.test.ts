import { describe, expect, it, vi } from "vitest";
import { generateLadder, replayLadder, type LadderStructure } from "../../lib/server/events/ladder";

const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// Enumerates ALL Fisher–Yates draw sequences, not random trials.
function sequences(n: number): number[][] {
  if (n === 1) return [[]];
  return Array.from({ length: n }, (_, j) => sequences(n - 1).map((rest) => [j, ...rest])).flat();
}

function frozenTree(value: unknown): void {
  if (value && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const nested of Object.values(value)) frozenTree(nested);
  }
}

describe("event ladder", () => {
  it.each([2, 3, 4, 5])("realizes every mapping exactly once for N=%i", (n) => {
    const participants = ids(n, "p");
    const slots = ids(n, "s");
    const mappings = new Set<string>();
    const counts = Array.from({ length: n }, () => Array(n).fill(0));
    for (const draws of sequences(n)) {
      let call = 0;
      const result = generateLadder(participants, slots, (upper) => {
        expect(upper).toBe(n - call);
        return draws[call++];
      });
      expect(call).toBe(n - 1);
      // Independent reference: place/remove selected remaining participants.
      const remaining = Array.from({ length: n }, (_, i) => i);
      const bottom = Array<number>(n);
      for (let i = n - 1; i > 0; i--) {
        const j = draws[n - 1 - i];
        bottom[i] = remaining[j];
        remaining[j] = remaining[i];
        remaining.pop();
      }
      bottom[0] = remaining[0];
      const expected = participants.map((_, i) => bottom.indexOf(i));
      expect(result.routes.map((route) => route.endLane)).toEqual(expected);
      mappings.add(expected.join(","));
      expect(new Set(result.routes.map((route) => route.outcomeSlotId)).size).toBe(n);
      for (const row of result.structure.rows) {
        const used = new Set<number>();
        for (const left of row) {
          expect(left).toBeGreaterThanOrEqual(0);
          expect(left).toBeLessThan(n - 1);
          expect(used.has(left) || used.has(left + 1)).toBe(false);
          used.add(left); used.add(left + 1);
        }
      }
      for (const route of result.routes) {
        // Traverse rows independently using their connected lane pairs.
        let lane = route.startLane;
        const path = [lane];
        for (const row of result.structure.rows) {
          const edges = row.flatMap((left) => [[left, left + 1], [left + 1, left]]);
          lane = edges.find(([from]) => from === lane)?.[1] ?? lane;
          path.push(lane);
        }
        expect(route.lanes).toEqual(path);
        expect(route.endLane).toBe(lane);
        expect(route.outcomeSlotId).toBe(slots[lane]);
        expect(route.participantId).toBe(participants[route.startLane]);
        counts[route.startLane][lane]++;
      }
      expect(replayLadder(JSON.parse(JSON.stringify(result.structure)))).toEqual(result);
      frozenTree(result);
    }
    const factorial = sequences(n).length;
    expect(mappings.size).toBe(factorial);
    expect(counts).toEqual(Array.from({ length: n }, () => Array(n).fill(factorial / n)));
  });

  it("uses deterministic injected draws and never regenerates while replaying", () => {
    const random = vi.fn(() => 0);
    const result = generateLadder(ids(4, "p"), ids(4, "s"), random);
    expect(random.mock.calls).toEqual([[4], [3], [2]]);
    const stored = JSON.parse(JSON.stringify(result.structure));
    random.mockImplementation(() => { throw new Error("must not regenerate"); });
    expect(replayLadder(stored)).toEqual(result);
    expect(replayLadder(stored)).toEqual(result);
    expect(random).toHaveBeenCalledTimes(3);
    expect(generateLadder(ids(4, "p"), ids(4, "s"), () => 0)).toEqual(result);
  });

  it("copies inputs and supports singleton and identity results without rungs", () => {
    const participants = ["p"];
    const slots = ["s"];
    const random = vi.fn(() => 0);
    const singleton = generateLadder(participants, slots, random);
    participants[0] = "changed"; slots[0] = "changed";
    expect(singleton.routes[0]).toEqual({ participantId: "p", outcomeSlotId: "s", startLane: 0, endLane: 0, lanes: [0] });
    expect(random).not.toHaveBeenCalled();
    expect(generateLadder(ids(5, "p"), ids(5, "s"), (upper) => upper - 1).structure.rows).toEqual([]);
    expect(() => { (singleton.structure.rows as number[][]).push([0]); }).toThrow();
  });

  it("replays legal simultaneous disjoint rungs and straight rows, copying storage", () => {
    const stored: LadderStructure = { version: 1, participantIds: ids(4, "p"), outcomeSlotIds: ids(4, "s"), rows: [[2, 0], [], [1]] };
    const result = replayLadder(stored);
    expect(result.routes.map((r) => r.endLane)).toEqual([2, 0, 3, 1]);
    (stored.rows[0] as number[])[0] = 1;
    expect(result.structure.rows[0]).toEqual([2, 0]);
    frozenTree(result);
  });

  it("handles the internal allocation ceiling with the worst-case reverse mapping", () => {
    const n = 128;
    // Produce reverse order via the exact Fisher–Yates choice sequence.
    const target = Array.from({ length: n }, (_, i) => n - 1 - i);
    const current = Array.from({ length: n }, (_, i) => i);
    const draws: number[] = [];
    for (let i = n - 1; i > 0; i--) {
      const j = current.indexOf(target[i]);
      draws.push(j);
      [current[i], current[j]] = [current[j], current[i]];
    }
    let draw = 0;
    const reversed = generateLadder(ids(n, "p"), ids(n, "s"), () => draws[draw++]);
    expect(reversed.structure.rows).toHaveLength(n * (n - 1) / 2);
    expect(reversed.routes.map((r) => r.endLane)).toEqual(target);
    expect(replayLadder(reversed.structure)).toEqual(reversed);
  });

  it("runs with the default server crypto source", () => {
    const result = generateLadder(ids(5, "p"), ids(5, "s"));
    expect(new Set(result.routes.map((r) => r.endLane)).size).toBe(5);
    expect(replayLadder(result.structure)).toEqual(result);
  });

  it.each([
    [[], []], [["p"], []], [["p", "p"], ["s", "t"]],
    [["p", "q"], ["s", "s"]], [[" "], ["s"]], [["p"], [""]],
    [ids(129, "p"), ids(129, "s")],
  ])("rejects malformed counts or IDs %# before drawing", (participants, slots) => {
    const random = vi.fn(() => 0);
    expect(() => generateLadder(participants, slots, random)).toThrow();
    expect(random).not.toHaveBeenCalled();
  });

  it.each([-1, 2, 0.5, NaN, Infinity])("rejects invalid random output %s", (draw) => {
    expect(() => generateLadder(ids(2, "p"), ids(2, "s"), () => draw)).toThrow();
  });

  it.each([
    { version: 2, rows: [] }, { version: 1, rows: [[-1]] },
    { version: 1, rows: [[3]] }, { version: 1, rows: [[0.5]] },
    { version: 1, rows: [[0, 1]] }, { version: 1, rows: [[1, 1]] },
    { version: 1, rows: Array.from({ length: 7 }, () => []) },
    { version: 1, rows: [null] }, { version: 1, rows: null },
  ])("rejects malformed stored structure %#", (partial) => {
    expect(() => replayLadder({ participantIds: ids(4, "p"), outcomeSlotIds: ids(4, "s"), ...partial } as LadderStructure)).toThrow();
  });

  it("rejects malformed runtime inputs without trusting static types", () => {
    for (const participants of [null, {}, [1], Array(2)]) {
      expect(() => generateLadder(participants as unknown as string[], ["s"])).toThrow();
    }
    expect(() => replayLadder(null as unknown as LadderStructure)).toThrow();
    expect(() => generateLadder(["p"], ["s"], null as unknown as () => number)).toThrow();
  });
});
