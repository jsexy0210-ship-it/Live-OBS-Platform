"use client";

import "../../styles/overlay.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { WidgetView } from "./WidgetView";
import type { EventCardData, LiveData, OrderEvent, RankingRow, Widget } from "./layout";

// OBS 오버레이(OV-001 세로 1080×1920 · OV-002 가로 1920×1080, 배경 투명). 위젯 배치는 판매자가 편집기(SA-051)에서 정한 레이아웃(GET /api/overlay/{token}/layout)대로 그린다.
// 상태: GET /api/overlay/{token}/state. 실시간 채널(stream, SSE)의 version이 바뀌면 다시 읽고, 끊겨도 15초마다 version을 확인한다.
// 레이아웃 저장은 version을 올리지 않으므로 레이아웃은 따로 읽는다: 처음 한 번, 그 뒤 15초마다 다시 읽어 레이아웃 version이 바뀌면 바꿔 그린다.
// 토큰이 폐기(재발급)되거나 쇼핑몰이 잠기면 서버가 404를 준다 → 주문 표시를 지우고 주소 확인 안내만 남긴다(OV-006).
// 신규 주문 알림: state.orderEvents(최근 30초 주문)에서 처음 보는 id만, 주문 종류(첫 주문·재주문·VIP)에 맞는 variant 위젯을 durationSec 동안 띄운다(그 variant 위젯이 없으면 첫 주문 위젯으로). 처음 읽을 때 이미 있던 주문은 띄우지 않는다.

type Item = { id: string; nickname: string; gradeSnapshot: string | null; productLabel: string; quantity: number; timerSeconds?: number | null; openingStartedAt?: string | null };
type State = {
  version: number;
  live: boolean;
  opening: Item | null;
  waiting: Item[];
  hits?: { id: string; cardName: string; nickname: string; createdAt?: string }[];
  shop?: { name: string; url: string | null };
  orderEvents?: OrderEvent[];
  eventCard?: EventCardData | null;
  purchaseRanking?: RankingRow[];
};
// 신규 주문 알림: 위젯(variant)마다 지금 보여 주는 주문과 끝나는 시각
type Shown = { event: OrderEvent; until: number };
// 새 HIT 카드를 강조하는 시간
const HIT_FRESH_MS = 8_000;
type Layout = { aspect: string; version: number; widgets: Widget[] };
type View = { kind: "loading" } | { kind: "gone" } | { kind: "offline" } | { kind: "ok"; state: State; stateReceivedAt: number; offline: boolean };

const POLL_MS = 15_000;
// 실시간 채널 오류로 다시 읽는 간격: 처음 오류는 바로 확인하고, 계속 실패하면 3초에서 30초까지 늘린다(서버가 죽어 있을 때 3초마다 읽지 않게)
const ERROR_RELOAD_MIN_MS = 3_000;
const ERROR_RELOAD_MAX_MS = 30_000;
const OFFLINE_NOTICE_DELAY_MS = 2_000;

// 연결 실패: 그린 화면이 있으면 그대로 두고 안내만 더하고, 아직 한 번도 못 그렸으면 안내만 보인다(OV-006). 주소가 바뀐 상태는 그대로 둔다
const offline = (v: View): View => (v.kind === "ok" ? { ...v, offline: true } : v.kind === "gone" ? v : { kind: "offline" });

export function OverlayView({ token, landscape }: { token: string; landscape: boolean }) {
  const base = `/api/overlay/${encodeURIComponent(token)}`;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [scale, setScale] = useState(1);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [shownAlerts, setShownAlerts] = useState<Record<string, Shown>>({});
  const seenEvents = useRef<Set<string> | null>(null);
  const seenHits = useRef<Set<string> | null>(null);
  const [freshHits, setFreshHits] = useState<Record<string, number>>({});
  const layoutRef = useRef<Layout | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const W = landscape ? 1920 : 1080;
  const H = landscape ? 1080 : 1920;

  // 늦게 온 옛 응답이 새 상태를 덮지 않게 보낸 순서로 거른다
  const sent = useRef(0);
  const applied = useRef(0);
  const version = useRef<number | null>(null);
  // 연결이 끊겼다고 표시한 동안에는 version이 그대로여도 다시 읽어 안내를 거둔다(회복 뒤 같은 version이 와도)
  const isOffline = useRef(false);
  const errorReload = useRef({ at: 0, gap: ERROR_RELOAD_MIN_MS });
  const lossStartedAt = useRef<number | null>(null);
  const frozenNow = useRef<number | null>(null);
  const lossTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadRef = useRef<() => void>(() => {});
  const resetLoss = useCallback(() => {
    if (lossTimer.current) clearTimeout(lossTimer.current);
    if (probeTimer.current) clearInterval(probeTimer.current);
    lossTimer.current = null;
    probeTimer.current = null;
    lossStartedAt.current = null;
    frozenNow.current = null;
    isOffline.current = false;
  }, []);
  const markOffline = useCallback(() => {
    if (lossStartedAt.current !== null) return;
    lossStartedAt.current = Date.now();
    // 2초 안에 복구되면 안내를 보이지 않도록 짧게 다시 확인한다.
    probeTimer.current = setInterval(() => loadRef.current(), 500);
    lossTimer.current = setTimeout(() => {
      if (lossStartedAt.current === null) return;
      frozenNow.current = lossStartedAt.current;
      isOffline.current = true;
      if (probeTimer.current) clearInterval(probeTimer.current);
      probeTimer.current = null;
      setView(offline);
    }, OFFLINE_NOTICE_DELAY_MS);
  }, []);
  const load = useCallback(async () => {
    const n = ++sent.current;
    let res: Response;
    try {
      res = await fetch(`${base}/state`, { cache: "no-store" });
    } catch {
      if (n > applied.current) markOffline();
      return;
    }
    if (n <= applied.current) return;
    if (res.status === 404) {
      applied.current = n;
      version.current = null;
      resetLoss();
      return setView({ kind: "gone" });
    }
    if (!res.ok) return markOffline();
    const state = (await res.json().catch(() => null)) as State | null;
    if (n <= applied.current) return;
    if (!state) return markOffline();
    applied.current = n;
    version.current = state.version;
    resetLoss();
    errorReload.current.gap = ERROR_RELOAD_MIN_MS;
    setView({ kind: "ok", state, stateReceivedAt: Date.now(), offline: false });
    // 새 HIT 카드 강조: 처음 읽을 때 이미 있던 카드는 강조하지 않는다
    const hitIds = (state.hits ?? []).map((h) => h.id);
    if (seenHits.current === null) seenHits.current = new Set(hitIds);
    else {
      const added = hitIds.filter((id) => !seenHits.current!.has(id));
      if (added.length > 0) {
        added.forEach((id) => seenHits.current!.add(id));
        setFreshHits((cur) => ({ ...cur, ...Object.fromEntries(added.map((id) => [id, Date.now() + HIT_FRESH_MS])) }));
      }
    }
    // 신규 주문 알림
    const events = state.orderEvents ?? [];
    if (seenEvents.current === null) {
      seenEvents.current = new Set(events.map((e) => e.id));
      return;
    }
    const fresh = events.filter((e) => !seenEvents.current!.has(e.id)).reverse();
    if (fresh.length === 0) return;
    fresh.forEach((e) => seenEvents.current!.add(e.id));
    const widgets = (layoutRef.current?.widgets ?? []).filter((w) => w.visible && w.type === "NEW_ORDER_ALERT");
    setShownAlerts((cur) => {
      const next = { ...cur };
      for (const e of fresh) {
        const variant = { FIRST: "first", REPEAT: "repeat", VIP: "vip" }[e.kind];
        const w = widgets.find((x) => x.props.variant === variant) ?? widgets.find((x) => x.props.variant === "first");
        if (!w) continue;
        const sec = typeof w.props.durationSec === "number" ? w.props.durationSec : 6;
        next[w.id] = { event: e, until: Date.now() + sec * 1000 };
      }
      return next;
    });
  }, [base, markOffline, resetLoss]);
  loadRef.current = () => void load();

  const layoutVersion = useRef<number | null>(null);
  const aspect = landscape ? "16x9" : "9x16";
  const loadLayout = useCallback(async () => {
    if (isOffline.current) return;
    try {
      const res = await fetch(`${base}/layout?aspect=${aspect}`, { cache: "no-store" });
      if (!res.ok) return;
      const l = (await res.json()) as Layout;
      if (l.version === layoutVersion.current) return;
      layoutVersion.current = l.version;
      layoutRef.current = l;
      setLayout(l);
    } catch {
      /* 다음 확인 때 다시 */
    }
  }, [base, aspect]);

  useEffect(() => {
    void load();
    void loadLayout();
    const onVersion = (v: unknown) => {
      if (typeof v !== "number" || v !== version.current || isOffline.current) void load();
    };
    let es: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      es = new EventSource(`${base}/stream`);
      es.addEventListener("version", (e) => {
        try {
          onVersion((JSON.parse((e as MessageEvent).data) as { version?: unknown }).version);
        } catch {
          void load();
        }
      });
      es.addEventListener("resync", () => void load());
      // 서버가 채널을 닫으면(토큰 폐기 등) 바로 상태를 다시 읽어 확인한다
      es.addEventListener("error", () => {
        const r = errorReload.current;
        const t = Date.now();
        if (t - r.at < r.gap) return;
        r.at = t;
        r.gap = Math.min(r.gap * 2, ERROR_RELOAD_MAX_MS);
        void load();
      });
    }
    const poll = setInterval(() => {
      void loadLayout();
      fetch(`${base}/version`, { cache: "no-store" })
        .then(async (r) => (r.status === 404 ? onVersion(null) : r.ok ? onVersion(((await r.json()) as { version?: unknown }).version) : undefined))
        .catch(markOffline);
    }, POLL_MS);
    return () => {
      es?.close();
      clearInterval(poll);
      resetLoss();
    };
  }, [base, load, loadLayout, markOffline, resetLoss]);

  // 개봉 타이머를 1초마다 갱신
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // OBS 브라우저 소스(1080×1920·1920×1080)에서는 1배, 다른 크기 창에서는 비율을 지켜 맞춘다
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [W, H]);

  const state = view.kind === "ok" ? view.state : null;
  const renderNow = view.kind === "ok" && view.offline ? frozenNow.current ?? now : now;
  const data: LiveData | null = state ? { live: state.live, opening: state.opening, waiting: state.waiting, hits: state.hits ?? [], eventCard: state.eventCard ?? null, purchaseRanking: state.purchaseRanking ?? [], freshHitIds: Object.keys(freshHits).filter((id) => freshHits[id]! > renderNow), shop: state.shop ?? null, alert: null } : null;
  // 방송 준비 중에는 두 빈 패널을 유지하고, 방송 중 개봉 전 현재 주문 칸은 기존처럼 숨긴다.
  const shown = (layout?.widgets ?? []).filter(
    (w) =>
      w.visible &&
      !(w.type === "CURRENT_ORDER" && state?.live && !state.opening) &&
      !(w.type === "NEW_ORDER_ALERT" && !(shownAlerts[w.id] && shownAlerts[w.id]!.until > renderNow)),
  );

  return (
    <div className="ovl-root">
      <div className={`ovl ${landscape ? "ovl-land" : "ovl-port"}${view.kind === "ok" && view.offline ? " ovl-offline" : ""}`} style={{ width: W, height: H, transform: `scale(${scale})` }} data-testid="overlay">
        {view.kind === "offline" && (
          <div className="ovl-disconnect" role="status"><b data-testid="overlay-offline">연결이 끊겼어요. 다시 연결하는 중이에요</b></div>
        )}
        {view.kind === "gone" && (
          <div className="ovl-pill ovl-notice" role="status" data-testid="overlay-gone">
            지금은 오버레이를 보여 드릴 수 없어요. 파트너스 관리자에서 주소를 확인해 주세요
          </div>
        )}
        {state && data && (
          <>
            {view.kind === "ok" && view.offline && (
              <div className="ovl-disconnect" role="status">
                <b data-testid="overlay-offline">연결이 끊겼어요. 다시 연결하는 중이에요</b>
                <span>{Math.max(0, Math.floor((now - view.stateReceivedAt) / 1000))}초 전 화면이에요</span>
              </div>
            )}
            {!state.live && !state.opening && (
              <div className="ovl-pill ovl-top" data-testid="overlay-idle">
                방송 준비 중이에요
              </div>
            )}
            {shown.map((w) => (
              <WidgetView
                key={`${w.id}:${w.type === "NEW_ORDER_ALERT" ? shownAlerts[w.id]?.event.id : ""}`}
                widget={w}
                data={w.type === "NEW_ORDER_ALERT" ? { ...data, alert: shownAlerts[w.id]?.event ?? null } : data}
                now={renderNow}
                landscape={landscape}
                stateReceivedAt={view.kind === "ok" ? view.stateReceivedAt : now}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
