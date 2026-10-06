"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminApi } from "./api";

// 운영 현황·실시간 감시 응답과 공통 부품(GET /api/admin/ops/live-broadcasts·seller-activity·live-payout-sellers·monitor, MA-041·042·043·100)
export type Overlay = { hasUrl: boolean; connected: boolean; lastSeenAt: string | null };
export const OVERLAY_STATE = (o: Overlay): { label: string; cls: string } =>
  !o.hasUrl ? { label: "주소 없음", cls: "b-gray" } : o.connected ? { label: "접속 중", cls: "b-done" } : { label: "접속 안 됨", cls: "b-warn" };

export type LiveBroadcast = {
  sellerId: string;
  shopName: string;
  slug: string;
  sellerStatus: string;
  broadcastId: string;
  title: string | null;
  startedAt: string;
  queue: { waiting: number; opening: number; done: number; cancelled: number };
  orders: number;
  overlay: Overlay;
  layoutAspect: string | null;
  paymentError: boolean;
};
export type SellerActivity = {
  sellerId: string;
  shopName: string;
  slug: string;
  status: "ACTIVE" | "SUSPENDED";
  ordersToday: { created: number; paid: number; paidAmount: number };
  live: { startedAt: string } | null;
  overlay: Overlay;
};
export type PayoutSeller = {
  sellerId: string;
  shopName: string;
  slug: string;
  status: string;
  enabledAt: string | null;
  earnTiming: "ON_PAYMENT" | "ON_DELIVERY";
  outstanding: { amount: number; members: number };
};

export type Monitor = {
  at: string;
  servers: { total: number; healthy: number; stale: number; noSignal: number };
  jobs: { job: string; lastRunAt: string; lastStatus: string; lastOkAt: string | null; instances: number; healthy: boolean; lastError?: string | null }[];
  queue: { automationQueued: number; oldestQueuedAt: string | null };
  paymentChecks: { kind: string; pending: number; oldestAt: string | null }[];
  webhooks: "not_measured";
  autoActions: { id: string; action: string; targetType: string | null; targetId: string | null; sellerId: string | null; createdAt: string }[];
  incidents: { source: string; key: string; severity: string; message: string; occurredAt: string }[];
};
export const PAYMENT_CHECK: Record<string, string> = { order_payment: "주문 결제 승인", subscription: "구독 청구", automation: "자동 연결 결제", message_charge: "발송·이용 충전" };

// 몇 시간 몇 분째(방송 시간 표시)
export function elapsed(fromIso: string, now: number): string {
  const min = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)}시간 ${min % 60}분` : `${min}분`;
}

// 일정 주기로 다시 읽는 목록. 읽기에 실패하면 마지막으로 읽은 내용은 그대로 두고 failed로 알린다. 겹치는 요청은 건너뛴다.
export function usePoll<T>(path: string, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [first, setFirst] = useState(true);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const r = await adminApi<T>(path);
    busy.current = false;
    setFirst(false);
    if (r.ok) {
      setData(r.data);
      setLastOk(Date.now());
      setFailed(false);
    } else setFailed(true);
  }, [path]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), ms);
    return () => clearInterval(t);
  }, [load, ms]);
  return { data, failed, first, lastOk, reload: load };
}
export const clock = (ms: number | null) =>
  ms === null ? "-" : new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(ms));
