import { randomInt } from "node:crypto";

export type DrawInput = {
  candidateIds: readonly string[];
  previousWinnerIds?: readonly string[];
  excludedIds?: readonly string[];
  winnerCount: number;
  allowDuplicateWinners: boolean;
};

export type DrawOutcome = {
  selectedIds: string[];
  /** Eligible IDs before this draw, in their original order. */
  eligibleCandidateIds: string[];
  /** Eligible IDs for the next draw with the same rules. Replacement preserves this pool. */
  remainingCandidateIds: string[];
  rules: {
    winnerCount: number;
    allowDuplicateWinners: boolean;
    excludePreviousWinners: boolean;
    excludedIds: string[];
    sampling: "WITHOUT_REPLACEMENT" | "WITH_REPLACEMENT";
    probability: "EQUAL";
  };
};

type RandomIndex = (maxExclusive: number) => number;
const secureIndex: RandomIndex = maxExclusive => randomInt(maxExclusive);

function uniqueIds(ids: readonly string[], field: string): Set<string> {
  if (!Array.isArray(ids)) throw new TypeError(`${field} must be an array`);
  const unique = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !id.trim()) throw new TypeError(`${field} must contain nonempty stable IDs`);
    if (unique.has(id)) throw new TypeError(`${field} must contain unique IDs`);
    unique.add(id);
  }
  return unique;
}

/** Validate frozen server inputs and preview candidates/rules without consuming randomness. */
export function previewEqualChanceDraw(input: DrawInput): Pick<DrawOutcome, "eligibleCandidateIds" | "rules"> {
  const allowed = new Set(["candidateIds", "previousWinnerIds", "excludedIds", "winnerCount", "allowDuplicateWinners"]);
  if (!input || typeof input !== "object" || Object.keys(input).some(key => !allowed.has(key))) {
    throw new TypeError("Unsupported draw input");
  }
  uniqueIds(input.candidateIds, "candidateIds");
  const previous = uniqueIds(input.previousWinnerIds === undefined ? [] : input.previousWinnerIds, "previousWinnerIds");
  const excluded = uniqueIds(input.excludedIds === undefined ? [] : input.excludedIds, "excludedIds");
  if (!Number.isSafeInteger(input.winnerCount) || input.winnerCount < 1) {
    throw new RangeError("winnerCount must be a positive safe integer");
  }
  if (typeof input.allowDuplicateWinners !== "boolean") throw new TypeError("allowDuplicateWinners must be boolean");
  if (!input.allowDuplicateWinners) for (const id of previous) excluded.add(id);
  const eligible = input.candidateIds.filter(id => !excluded.has(id));
  if (eligible.length === 0) throw new RangeError("No eligible candidates");
  if (!input.allowDuplicateWinners && input.winnerCount > eligible.length) {
    throw new RangeError("winnerCount exceeds eligible candidates");
  }
  return {
    eligibleCandidateIds: eligible,
    rules: {
      winnerCount: input.winnerCount,
      allowDuplicateWinners: input.allowDuplicateWinners,
      excludePreviousWinners: !input.allowDuplicateWinners,
      excludedIds: [...excluded],
      sampling: input.allowDuplicateWinners ? "WITH_REPLACEMENT" : "WITHOUT_REPLACEMENT",
      probability: "EQUAL",
    },
  };
}

/**
 * Server-only equal-chance outcome for entrant draws and roulette item IDs.
 * Callers must freeze the candidate snapshot and save this outcome before animation.
 * The second argument is trusted server-side test injection, never request input.
 * No weights, purchases, seeds, or predetermined winner fields are accepted.
 */
export function drawEqualChance(input: DrawInput, randomIndex: RandomIndex = secureIndex): DrawOutcome {
  const preview = previewEqualChanceDraw(input);
  const pool = [...preview.eligibleCandidateIds];
  const selectedIds: string[] = [];
  for (let winner = 0; winner < preview.rules.winnerCount; winner++) {
    const index = randomIndex(pool.length);
    if (!Number.isInteger(index) || index < 0 || index >= pool.length) throw new RangeError("Invalid random index");
    selectedIds.push(pool[index]);
    if (!preview.rules.allowDuplicateWinners) pool.splice(index, 1);
  }
  return { ...preview, selectedIds, remainingCandidateIds: pool };
}
