import { randomUUID } from "node:crypto";
import type { AudienceEventKind } from "@prisma/client";
import { drawEqualChance, previewEqualChanceDraw, type DrawOutcome } from "./draw";
import { generateLadder, replayLadder, type LadderResult } from "./ladder";
import { EventError } from "./errors";

export type NamedCandidate = { id: string; label: string };
export type ExecutionSettings = { allowDuplicateWinners: boolean; items?: NamedCandidate[]; outcomeSlots?: NamedCandidate[] };
export type ExecutionSnapshot = { kind: AudienceEventKind; winnerCount: number; settings: ExecutionSettings; entrantIds: string[]; previousWinnerIds?: string[] };
export type EventExecution = { version: 2; kind: AudienceEventKind; draw?: DrawOutcome; ladder?: LadderResult };
const invalid = (): never => { throw new EventError(400, "invalid_event_rules"); };

// 설정 라벨만 요청에서 받는다. 후보 ID는 서버에서 생성하며 가중치/지정 당첨자/seed는 받지 않는다.
export function normalizeExecutionSettings(kind: AudienceEventKind, input: { allowDuplicateWinners?: unknown; items?: unknown; outcomeSlots?: unknown }) {
  const allowDuplicateWinners = input.allowDuplicateWinners === undefined ? false : input.allowDuplicateWinners;
  if (typeof allowDuplicateWinners !== "boolean") invalid();
  if (kind === "LADDER" && allowDuplicateWinners) invalid();
  const labels = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 5_000) return invalid();
    return value.map(label => {
      if (typeof label !== "string" || !label.trim() || Array.from(label.trim()).length > 100) return invalid();
      return label.trim();
    });
  };
  if (kind !== "ROULETTE_ITEM" && input.items !== undefined) invalid();
  if (kind !== "LADDER" && input.outcomeSlots !== undefined) invalid();
  return { allowDuplicateWinners, ...(kind === "ROULETTE_ITEM" ? { items: labels(input.items) } : {}), ...(kind === "LADDER" ? { outcomeSlots: labels(input.outcomeSlots) } : {}) };
}
export function allocateExecutionSettings(config: ReturnType<typeof normalizeExecutionSettings>): ExecutionSettings {
  return { allowDuplicateWinners: config.allowDuplicateWinners as boolean, ...(config.items ? { items: config.items.map(label => ({ id: randomUUID(), label })) } : {}), ...(config.outcomeSlots ? { outcomeSlots: config.outcomeSlots.map(label => ({ id: randomUUID(), label })) } : {}) };
}

function candidatesOf(snapshot: ExecutionSnapshot): string[] {
  return snapshot.kind === "ROULETTE_ITEM" ? (snapshot.settings.items ?? []).map(item => item.id) : snapshot.entrantIds;
}
// 미리보기는 대상/규칙만 검사한다. 사다리를 새로 생성하거나 난수를 소비하지 않는다.
export function previewEventExecution(snapshot: ExecutionSnapshot) {
  const ids = candidatesOf(snapshot);
  try {
    if (snapshot.kind === "LADDER") {
      const slots = snapshot.settings.outcomeSlots ?? [];
      if (ids.length !== slots.length) throw new EventError(409, "ladder_slot_count_mismatch");
      // 헬퍼의 내부 allocation 안전 guard를 그대로 사용한다. 제품 참여 인원 제한으로 표시하지 않는다.
      replayLadder({ version: 1, participantIds: ids, outcomeSlotIds: slots.map(slot => slot.id), rows: [] });
      return { candidateIds: ids, outcomeSlots: slots, rules: { probability: "EQUAL", mapping: "ONE_TO_ONE", allowDuplicateWinners: false } };
    }
    const preview = previewEqualChanceDraw({ candidateIds: ids, previousWinnerIds: snapshot.previousWinnerIds, winnerCount: snapshot.winnerCount, allowDuplicateWinners: snapshot.settings.allowDuplicateWinners });
    return { candidateIds: preview.eligibleCandidateIds, items: snapshot.kind === "ROULETTE_ITEM" ? snapshot.settings.items : undefined, rules: preview.rules };
  } catch (error) {
    if (error instanceof EventError) throw error;
    if (error instanceof RangeError) throw new EventError(409, snapshot.kind === "LADDER" ? "ladder_resource_guard" : "not_enough_candidates");
    throw new EventError(409, "invalid_frozen_rules");
  }
}
export function executeEventSnapshot(snapshot: ExecutionSnapshot): EventExecution {
  previewEventExecution(snapshot);
  if (snapshot.kind === "LADDER") {
    return { version: 2, kind: snapshot.kind, ladder: generateLadder(snapshot.entrantIds, snapshot.settings.outcomeSlots!.map(slot => slot.id)) };
  }
  return { version: 2, kind: snapshot.kind, draw: drawEqualChance({ candidateIds: candidatesOf(snapshot), previousWinnerIds: snapshot.previousWinnerIds, winnerCount: snapshot.winnerCount, allowDuplicateWinners: snapshot.settings.allowDuplicateWinners }) };
}

// 실제 저장된 v1 회차도 읽으며, v2는 frozen rules의 설정만 사용한다. 요청에서 실행 규칙을 덮어쓰지 않는다.
export function executionSnapshotOf(rules: unknown, entrantIds: unknown): ExecutionSnapshot {
  if (!rules || typeof rules !== "object" || Array.isArray(rules) || !Array.isArray(entrantIds)) throw new EventError(409, "invalid_frozen_rules");
  const value = rules as Record<string, unknown>;
  if (!["RANDOM_DRAW", "ROULETTE_PARTICIPANT", "ROULETTE_ITEM", "LADDER"].includes(value.kind as string) || !Number.isSafeInteger(value.winnerCount) || (value.winnerCount as number) < 1 || entrantIds.some(id => typeof id !== "string" || !id)) throw new EventError(409, "invalid_frozen_rules");
  const raw = value.settings;
  if (value.version !== 1 && value.version !== 2) throw new EventError(409, "invalid_frozen_rules");
  const settings = value.version === 1 ? { allowDuplicateWinners: false } : raw;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new EventError(409, "invalid_frozen_rules");
  const config = settings as Record<string, unknown>;
  if (typeof config.allowDuplicateWinners !== "boolean") throw new EventError(409, "invalid_frozen_rules");
  const named = (input: unknown): NamedCandidate[] | undefined => {
    if (input === undefined) return undefined;
    if (!Array.isArray(input) || input.some(item => !item || typeof item.id !== "string" || !item.id || typeof item.label !== "string" || !item.label.trim())) throw new EventError(409, "invalid_frozen_rules");
    return input.map(item => ({ id: item.id, label: item.label }));
  };
  const previousWinnerIds = value.previousWinnerIds === undefined ? [] : value.previousWinnerIds;
  if (!Array.isArray(previousWinnerIds) || previousWinnerIds.some(id => typeof id !== "string" || !id)) throw new EventError(409, "invalid_frozen_rules");
  const snapshot = { kind: value.kind as AudienceEventKind, winnerCount: value.winnerCount as number, entrantIds: [...entrantIds] as string[], previousWinnerIds: [...previousWinnerIds] as string[], settings: { allowDuplicateWinners: config.allowDuplicateWinners, items: named(config.items), outcomeSlots: named(config.outcomeSlots) } };
  if (snapshot.kind === "LADDER" && snapshot.settings.allowDuplicateWinners) throw new EventError(409, "invalid_frozen_rules");
  return snapshot;
}
