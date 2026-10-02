import type { QueueItemStatus } from "@prisma/client";

// 주문대기 상태 전이 규칙 (docs/ARCHITECTURE.md 4.6). 표에 없는 전이는 모두 거부한다.

export const REVERT_WINDOW_MS = 10_000;
export const TIMER_MAX_SECONDS = 3600;

export type QueueAction = "start" | "complete" | "revert" | "cancel" | "timer";

export type QueueRejection =
  | "invalid_transition"
  | "other_opening"
  | "not_live"
  | "revert_expired"
  | "invalid_timer"
  | "conflict"
  | "not_found"
  | "already_live"
  | "opening_in_progress";

export type TransitionInput = {
  status: QueueItemStatus;
  doneAt: Date | null;
  inLiveBroadcast: boolean;
};

export type TransitionContext = { now: Date; hasOtherOpening: boolean };

const ALLOWED_FROM: Record<QueueAction, readonly QueueItemStatus[]> = {
  start: ["WAITING"],
  complete: ["OPENING"],
  revert: ["DONE"],
  cancel: ["WAITING", "OPENING"],
  timer: ["WAITING", "OPENING"],
};

const TARGET: Record<QueueAction, QueueItemStatus | null> = {
  start: "OPENING",
  complete: "DONE",
  revert: "OPENING",
  cancel: "CANCELLED",
  timer: null,
};

export type TransitionResult = { ok: true; to: QueueItemStatus } | { ok: false; reason: QueueRejection };

export function checkTransition(item: TransitionInput, action: QueueAction, ctx: TransitionContext): TransitionResult {
  if (!ALLOWED_FROM[action].includes(item.status)) return { ok: false, reason: "invalid_transition" };
  if (action === "start") {
    if (!item.inLiveBroadcast) return { ok: false, reason: "not_live" };
    if (ctx.hasOtherOpening) return { ok: false, reason: "other_opening" };
  }
  if (action === "revert") {
    // 완료 후 10초 안(서버 시각 기준)이고 다른 개봉 중이 없을 때만 되돌린다.
    if (!item.doneAt || ctx.now.getTime() - item.doneAt.getTime() > REVERT_WINDOW_MS) {
      return { ok: false, reason: "revert_expired" };
    }
    if (ctx.hasOtherOpening) return { ok: false, reason: "other_opening" };
  }
  return { ok: true, to: TARGET[action] ?? item.status };
}

export function isValidTimer(seconds: unknown): seconds is number {
  return Number.isInteger(seconds) && (seconds as number) >= 0 && (seconds as number) <= TIMER_MAX_SECONDS;
}

// 순서 변경: 같은 범위의 「대기」 항목 전체를 빠짐없이, 중복 없이 보내야 한다.
export function isCompletePermutation(current: readonly string[], requested: readonly string[]): boolean {
  if (current.length !== requested.length) return false;
  const set = new Set(requested);
  if (set.size !== requested.length) return false;
  return current.every((id) => set.has(id));
}
