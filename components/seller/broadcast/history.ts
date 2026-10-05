import { kstTime } from "./queue";

// 방송 이력(SA-054)·방송 상세(SA-055) 공용 자료형과 표시 도우미. 서버 모양은 lib/server/broadcast/summary.ts·detail.ts·history.ts.
export type BroadcastSummary = { orders: number; paidOrders: number; sales: number; completed: number; cancelled: number; hits: number };

// 한국 시간 월/일 시:분
export function kstDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${kstTime(iso)}`;
}

// 방송 시간(시:분). 진행 중이면 지금까지
export function kstDuration(startedAt: string, endedAt: string | null, now = Date.now()): string {
  const ms = Math.max(0, (endedAt ? new Date(endedAt).getTime() : now) - new Date(startedAt).getTime());
  const min = Math.floor(ms / 60_000);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}
