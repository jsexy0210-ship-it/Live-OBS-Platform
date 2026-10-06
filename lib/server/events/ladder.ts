import { randomInt } from "node:crypto";

/**
 * Internal fail-closed allocation guard, NOT a confirmed product/UI limit.
 * This encoding stores up to N(N-1)/2 rows and N paths: O(N^3) lane entries.
 * Larger events need a more compact encoding and an agreed resource budget.
 */
const INTERNAL_ALLOCATION_CEILING = 128;

/** Must return independent, uniform integers in [0, exclusiveUpperBound). */
export type LadderRandomBelow = (exclusiveUpperBound: number) => number;

/** Each rung joins lane `leftLane` to `leftLane + 1`; rows run top to bottom. */
export type LadderStructure = Readonly<{
  version: 1;
  participantIds: readonly string[];
  outcomeSlotIds: readonly string[];
  rows: readonly (readonly number[])[];
}>;

export type LadderRoute = Readonly<{
  participantId: string;
  startLane: number;
  endLane: number;
  outcomeSlotId: string;
  /** Initial lane followed by the lane after every row, including straight rows. */
  lanes: readonly number[];
}>;

export type LadderResult = Readonly<{
  structure: LadderStructure;
  routes: readonly LadderRoute[];
}>;

function validateIds(ids: readonly string[], label: string): void {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > INTERNAL_ALLOCATION_CEILING) {
    throw new RangeError(`${label} must be nonempty and fit the internal allocation safety guard; this is not a product participant limit`);
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.trim().length === 0 || seen.has(id)) {
      throw new TypeError(`${label} must contain distinct nonempty string IDs`);
    }
    seen.add(id);
  }
}

function validatePair(participantIds: readonly string[], outcomeSlotIds: readonly string[]): void {
  validateIds(participantIds, "participantIds");
  validateIds(outcomeSlotIds, "outcomeSlotIds");
  if (participantIds.length !== outcomeSlotIds.length) {
    throw new RangeError("Participants and outcome slots must have equal counts");
  }
}

/**
 * Reconstruct only from the stored structure; no randomness or generation occurs.
 * Every legal row is a product of disjoint adjacent transpositions, hence a
 * bijection. Their composition consumes every outcome slot exactly once.
 * The returned snapshot copies and freezes every nested array and object.
 */
export function replayLadder(stored: LadderStructure): LadderResult {
  if (!stored || stored.version !== 1) throw new TypeError("Unsupported ladder version");
  validatePair(stored.participantIds, stored.outcomeSlotIds);
  const size = stored.participantIds.length;
  if (!Array.isArray(stored.rows) || stored.rows.length > size * (size - 1) / 2) {
    throw new RangeError("Invalid ladder row count");
  }
  const rows = stored.rows.map((row) => {
    if (!Array.isArray(row)) throw new TypeError("Ladder row must be an array");
    const used = new Set<number>();
    for (const leftLane of row) {
      if (!Number.isInteger(leftLane) || leftLane < 0 || leftLane >= size - 1 ||
          used.has(leftLane) || used.has(leftLane + 1)) {
        throw new TypeError("Rungs must join adjacent lanes without overlapping");
      }
      used.add(leftLane);
      used.add(leftLane + 1);
    }
    return Object.freeze([...row]);
  });
  const structure: LadderStructure = Object.freeze({
    version: 1,
    participantIds: Object.freeze([...stored.participantIds]),
    outcomeSlotIds: Object.freeze([...stored.outcomeSlotIds]),
    rows: Object.freeze(rows),
  });
  const paths = structure.participantIds.map((_, lane) => [lane]);
  // Build each row's lane transitions once. Even a stored row containing N/2
  // rungs costs O(N), instead of scanning its rungs again for every participant.
  // With at most N(N-1)/2 rows, replay time and path storage are O(N^3).
  for (const row of rows) {
    const nextLane = Array.from({ length: size }, (_, lane) => lane);
    for (const leftLane of row) {
      nextLane[leftLane] = leftLane + 1;
      nextLane[leftLane + 1] = leftLane;
    }
    for (const path of paths) {
      path.push(nextLane[path[path.length - 1]]);
    }
  }
  const routes = structure.participantIds.map((participantId, startLane): LadderRoute => {
    const lanes = paths[startLane];
    const endLane = lanes[lanes.length - 1];
    return Object.freeze({
      participantId, startLane, endLane,
      outcomeSlotId: structure.outcomeSlotIds[endLane],
      lanes: Object.freeze(lanes),
    });
  });
  return Object.freeze({ structure, routes: Object.freeze(routes) });
}

/**
 * Fisher–Yates draws j uniformly from [0,i] for i=N-1..1. Conditional on the
 * previous draws, each remaining item has probability 1/(i+1) of being fixed
 * at i. Each permutation has exactly one draw sequence and probability 1/N!.
 * Thus each participant reaches each slot with probability 1/N, provided the
 * injected source satisfies its independence/uniformity contract. The default
 * node:crypto randomInt avoids modulo bias. Simulations are not this proof.
 *
 * The shuffled array is the target participant order at the bottom. At lane k,
 * move its target participant left by adjacent swaps. By induction lanes <k
 * already match the target and stay untouched; after the moves lane k matches.
 * Each swap is emitted as its own legal rung row. Therefore visible traversal
 * realizes exactly the selected permutation, without changing its distribution.
 * Structure shapes themselves are not sampled uniformly.
 */
export function generateLadder(
  participantIds: readonly string[],
  outcomeSlotIds: readonly string[],
  randomBelow: LadderRandomBelow = (upperBound) => randomInt(upperBound),
): LadderResult {
  validatePair(participantIds, outcomeSlotIds);
  if (typeof randomBelow !== "function") throw new TypeError("Random source must be a function");
  const target = Array.from({ length: participantIds.length }, (_, i) => i);
  for (let i = target.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) {
      throw new RangeError("Random source returned an out-of-range integer");
    }
    [target[i], target[j]] = [target[j], target[i]];
  }
  const current = Array.from({ length: target.length }, (_, i) => i);
  const rows: number[][] = [];
  for (let lane = 0; lane < target.length; lane++) {
    let position = current.indexOf(target[lane], lane);
    while (position > lane) {
      const leftLane = position - 1;
      [current[leftLane], current[position]] = [current[position], current[leftLane]];
      rows.push([leftLane]);
      position--;
    }
  }
  return replayLadder({ version: 1, participantIds, outcomeSlotIds, rows });
}
