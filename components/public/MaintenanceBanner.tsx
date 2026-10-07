"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "./MaintenanceBanner.module.css";

export const MAINTENANCE_CHANGED = "onq:maintenance-changed";
type State = { active: boolean; scheduled: boolean; startsAt: string | null; endsAt: string | null };
const time = (iso: string | null) => iso ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) : "미정";

// 표시만 맡는다. 실제 전환은 기존 점검 설정과 proxy, 방송 판정은 tenant 보호 GET을 재사용한다.
export function MaintenanceBanner({ scope, canManage = false, checkLive = false }: { scope: "admin" | "seller"; canManage?: boolean; checkLive?: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [now, setNow] = useState(Date.now());
  const [live, setLive] = useState(false);
  useEffect(() => {
    let stopped = false;
    let running = false;
    let queued = false;
    let controller: AbortController | null = null;
    const read = async () => {
      if (running) { queued = true; return; }
      running = true;
      controller = new AbortController();
      try {
        const response = await fetch("/api/maintenance", { cache: "no-store", signal: controller.signal });
        const data = response.ok ? await response.json() as State : null;
        if (!stopped) setState(data);
      } catch {
        if (!stopped) setState(null);
      } finally {
        running = false;
        if (queued && !stopped) { queued = false; void read(); }
      }
    };
    const refresh = () => { if (document.visibilityState === "visible") void read(); };
    void read();
    const poll = setInterval(refresh, 30_000);
    const tick = scope === "seller" ? setInterval(() => setNow(Date.now()), 1000) : null;
    window.addEventListener(MAINTENANCE_CHANGED, refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      controller?.abort();
      clearInterval(poll);
      if (tick) clearInterval(tick);
      window.removeEventListener(MAINTENANCE_CHANGED, refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [scope]);
  const remaining = state?.scheduled && state.startsAt ? new Date(state.startsAt).getTime() - now : 0;
  const warning = remaining > 0 && remaining <= 600_000;
  useEffect(() => {
    if (scope !== "seller" || !checkLive || !warning) { setLive(false); return; }
    let stopped = false;
    let running = false;
    let controller: AbortController | null = null;
    const read = async () => {
      if (running) return;
      running = true;
      controller = new AbortController();
      try {
        const response = await fetch("/api/seller/broadcast/summary", { cache: "no-store", signal: controller.signal });
        const data = response.ok ? await response.json() as { broadcast: { status: string } | null } : null;
        if (!stopped) setLive(data?.broadcast?.status === "live");
      } catch {
        if (!stopped) setLive(false);
      } finally { running = false; }
    };
    void read();
    const poll = setInterval(() => { if (document.visibilityState === "visible") void read(); }, 30_000);
    return () => { stopped = true; controller?.abort(); clearInterval(poll); };
  }, [scope, checkLive, warning]);

  if (scope === "admin" && state?.active) return <div className={styles.banner} role="status" data-testid="maintenance-admin-banner"><span className={styles.text}><b>점검 중</b> · {state.startsAt ? `${time(state.startsAt)}부터` : "즉시 시작"} · 종료 예정 {time(state.endsAt)}</span>{canManage && <Link className={styles.action} href="/admin/settings/maintenance">점검 종료</Link>}</div>;
  if (scope === "seller" && checkLive && warning && live) return <div className={styles.banner} role="status" data-testid="maintenance-seller-banner"><span className={styles.text}><b>{Math.ceil(remaining / 60_000)}분 뒤 점검을 시작합니다</b> · 방송을 끝내 주십시오</span></div>;
  return null;
}
