"use client";

import "../../../../../styles/seller-broadcast.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { CancelItemModal, EndBroadcastModal, TimerModal } from "../../../../../components/seller/broadcast/Modals";
import { HitCardModal, type HitTarget } from "../../../../../components/seller/broadcast/HitCardModal";
import {
  REVERT_WINDOW_MS,
  TIMER_MAX_SECONDS,
  TIMER_STEP,
  clock,
  isUnclearFailure,
  kstTime,
  openingClock,
  rejectText,
  type QueueItem,
  type Snapshot,
} from "../../../../../components/seller/broadcast/queue";
import { won } from "../../../../../components/seller/format";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage, type ApiResult } from "../../../../../components/seller/api";
import { useLatestResponse } from "../../../../../components/seller/latestResponse";

// SA-001 방송 대시보드(정본: docs/IA.md SA-001, DESIGN_PROMPT 「실시간 주문대기 대시보드」).
// 방송 시작·종료, 주문대기 개봉 시작·완료·되돌리기(완료 후 10초)·취소(사유 필수)·타이머·순서 변경.
// 실시간: /api/seller/stream(SSE)의 version이 화면 것과 다르면 /api/seller/queue를 다시 받는다. SSE가 끊겨도 15초마다 version을 확인한다.
// 변경은 모두 서버 응답으로 확정한다: 결과가 불분명하면(연결 끊김·서버 오류) 성공으로 추정하지 않고 다시 읽어 보여 준다.
// HIT 카드 등록은 서버 API가 아직 없어 두지 않는다(Ctrl+H 단축키도 없음).
// API: GET /api/seller/queue·queue/version·stream, POST queue/{id}/{start|complete|revert|cancel|timer}·queue/reorder·broadcast/start·broadcast/end

type Load = { kind: "loading" } | { kind: "error"; status: number; error: string } | { kind: "ok"; snap: Snapshot };
// 위쪽 요약: GET /api/seller/broadcast/summary(지금 방송, 없으면 오늘 마지막 방송). 못 읽어도 대시보드는 그대로 쓴다(칸에 「-」)
type Summary = {
  broadcast: { id: string; title: string | null; status: "live" | "ended"; startedAt: string; endedAt: string | null } | null;
  summary: { orders: number; paidOrders: number; sales: number; completed: number; cancelled: number; hits: number };
};
// 유튜브 채팅 수집(GET /api/seller/youtube · …/live/chat-matches · PUT …/live/chat). 보조 정보라 못 읽으면 토글·「채팅」 열을 숨긴다(표시만, 주문·순서·개봉에 영향 없음)
type Yt = { configured: boolean; live: { chatEnabled: boolean } | null; chatNotice: string };
type ChatMatch = { matched: boolean; lastChatAt: string | null };
type Matches = { orders: { nickname: string; matched: boolean; lastChatAt: string | null }[] };
const CHAT_POLL_MS = 30_000;

type Modal = { kind: "hit" } | { kind: "chat-on" } | { kind: "end"; sessionId: string } | { kind: "cancel"; item: QueueItem } | { kind: "timer"; item: QueueItem } | null;

const POLL_MS = 15_000;

// 입력 중에는 단축키를 쓰지 않는다
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export default function BroadcastDashboardPage() {
  const { can } = useSeller();
  const allowed = can("BROADCAST_RUN");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const [stale, setStale] = useState(false);
  const [title, setTitle] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [sum, setSum] = useState<Summary | null>(null);
  const sumSeq = useRef(0);
  const [yt, setYt] = useState<Yt | null>(null);
  const [chat, setChat] = useState<Map<string, ChatMatch>>(new Map());
  const ytSeq = useRef(0);
  const [chatBusy, setChatBusy] = useState(false);
  // 나중에 보낸 읽기의 응답만 반영한다. 실패하면 이전 값을 지워 틀린 표시를 남기지 않는다
  const loadYoutube = useCallback(async () => {
    const n = ++ytSeq.current;
    const r = await api<Yt>("/api/seller/youtube");
    if (n !== ytSeq.current) return;
    if (!r.ok || !r.data.configured) {
      setYt(null);
      return setChat(new Map());
    }
    let map = new Map<string, ChatMatch>();
    if (r.data.live?.chatEnabled) {
      const m = await api<Matches>("/api/seller/youtube/live/chat-matches");
      if (n !== ytSeq.current) return;
      if (m.ok) for (const o of m.data.orders) if (o.matched || !map.has(o.nickname)) map.set(o.nickname, { matched: o.matched || map.get(o.nickname)?.matched === true, lastChatAt: o.lastChatAt });
    }
    setYt(r.data);
    setChat(map);
  }, []);

  // 다시 읽기 반영 규칙(latestResponse.ts): 나중에 보낸 요청의 성공만 반영하고, 실패가 앞선 성공을 버리지 않는다
  const reads = useLatestResponse();
  const version = useRef<number | null>(null);
  // 되돌리기 10초 판정은 PC 시계(Date)가 아니라 이 화면이 완료를 확인한 순간의 단조 시계(performance.now) 기준이다.
  // 이 화면에서 완료했거나, 직전 화면에서 개봉 중이던 주문이 완료로 바뀐 것을 본 경우만 기록한다(언제 완료됐는지 모르는 주문은 되돌리기를 보이지 않음)
  const doneSeenAt = useRef(new Map<string, number>());
  const lastOpeningId = useRef<string | null>(null);
  const applySnap = useCallback((snap: Snapshot) => {
    const seen = performance.now();
    for (const d of snap.recentDone) if (d.id === lastOpeningId.current && !doneSeenAt.current.has(d.id)) doneSeenAt.current.set(d.id, seen);
    lastOpeningId.current = snap.opening?.id ?? null;
    version.current = snap.version;
    setStale(false);
    setState({ kind: "ok", snap });
  }, []);
  const load = useCallback(async () => {
    const t = reads.next();
    const r = await api<Snapshot>("/api/seller/queue");
    if (!r.ok) {
      // 이용 기간 만료(402)·권한·플랜 해제(403)는 일시적 실패가 아니다: 보이던 내용을 지우고 해당 안내로 바꾼다
      const terminal = r.status === 402 || r.status === 403;
      if (reads.hasApplied() && !terminal) return reads.failMatters(t) ? setStale(true) : undefined;
      if (reads.hasApplied() && !reads.failMatters(t)) return;
      setStale(false);
      setModal(null);
      return setState({ kind: "error", status: r.status, error: r.error });
    }
    const verdict = reads.accept(t);
    // 변경 전에 보낸 읽기가 늦게 왔으면 버린다(변경 뒤 다시 읽기가 반영한다. 그 읽기가 실패했으면 낡음 안내가 남는다)
    if (verdict !== "apply") return;
    applySnap(r.data);
    // 요약은 보조 정보: 늦게 온 옛 응답은 버리고, 실패하면 이전 값을 지워 틀린 숫자를 남기지 않는다
    const n = ++sumSeq.current;
    void api<Summary>("/api/seller/broadcast/summary").then((s) => {
      if (n === sumSeq.current) setSum(s.ok ? s.data : null);
    });
    void loadYoutube();
  }, [reads, applySnap, loadYoutube]);

  // 처음 읽기 + 실시간 채널 + 15초 확인
  useEffect(() => {
    if (!allowed) return;
    void load();
    const onVersion = (v: unknown) => {
      if (typeof v === "number" && v !== version.current) void load();
    };
    let es: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      es = new EventSource("/api/seller/stream");
      es.addEventListener("version", (e) => {
        try {
          onVersion((JSON.parse((e as MessageEvent).data) as { version?: unknown }).version);
        } catch {
          void load();
        }
      });
      es.addEventListener("resync", () => void load());
    }
    const poll = setInterval(() => {
      void api<{ version: number }>("/api/seller/queue/version").then((r) => (r.ok ? onVersion(r.data.version) : undefined));
    }, POLL_MS);
    return () => {
      es?.close();
      clearInterval(poll);
    };
  }, [allowed, load]);

  // 채팅 수집 중에는 채팅이 계속 들어오므로 주문대기 version과 상관없이 주기적으로 다시 읽는다
  const chatOn = !!yt?.live?.chatEnabled;
  useEffect(() => {
    if (!allowed || !chatOn) return;
    const t = setInterval(() => void loadYoutube(), CHAT_POLL_MS);
    return () => clearInterval(t);
  }, [allowed, chatOn, loadYoutube]);

  const setChatEnabled = async (enabled: boolean) => {
    setChatBusy(true);
    const r = await api<{ chatEnabled: boolean }>("/api/seller/youtube/live/chat", { method: "PUT", body: { enabled } });
    setChatBusy(false);
    setModal(null);
    setToast(r.ok ? { text: enabled ? "채팅 수집을 켰습니다" : "채팅 수집을 껐습니다" } : { text: failMessage(r, "admin"), neg: true });
    await loadYoutube();
  };

  // 타이머·되돌리기 표시용 시계
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // 변경 요청 공통 처리: 결과(성공·거부·불분명)와 상관없이 보내기 직전에 그 전에 시작된 읽기를 모두 무효로 하고(confirmChange),
  // 끝나면 다시 읽어 서버 상태로 맞춘다. 다시 읽기가 끝날 때까지 조작을 막는다(옛 version으로 다음 요청을 보내 409가 나지 않게).
  // 결과가 불분명하면 성공을 추정하지 않는다.
  const mutate = useCallback(
    async <T,>(path: string, body: unknown, okText: string): Promise<ApiResult<T>> => {
      setBusy(true);
      reads.confirmChange();
      const r = await api<T>(path, { method: "POST", body });
      if (r.ok) {
        setModal(null);
        setToast({ text: okText });
      } else if (isUnclearFailure(r.status)) {
        setModal(null);
        setToast({ text: "처리 결과를 확인하지 못했습니다. 최신 상태를 다시 불러왔습니다. 화면에서 반영 여부를 확인해 주십시오", neg: true });
      } else {
        setToast({ text: rejectText(r.error) ?? failMessage(r, "admin"), neg: true });
        if (r.error !== "reason_required" && r.error !== "invalid_timer") setModal(null);
      }
      await load();
      setBusy(false);
      return r;
    },
    [load, reads],
  );

  // 방송 종료는 확인 창을 연 그 방송에만 한다. 종료 API는 방송을 지정받지 않아(지금 방송을 끝냄),
  // 보내기 직전에 서버의 지금 방송이 그 방송인지 다시 확인하고, 다르면 보내지 않는다.
  const endBroadcast = async (sessionId: string) => {
    setBusy(true);
    const t = reads.next();
    const r = await api<Snapshot>("/api/seller/queue");
    if (!r.ok || r.data.broadcast?.id !== sessionId) {
      setBusy(false);
      setModal(null);
      setToast({ text: r.ok ? "다른 화면에서 방송이 바뀌었습니다. 최신 내용을 확인한 뒤 다시 종료해 주십시오" : failMessage(r, "admin"), neg: true });
      if (r.ok && reads.accept(t) === "apply") applySnap(r.data);
      else void load();
      return;
    }
    setBusy(false);
    // broadcastSessionId: 서버가 지금 방송과 맞춰 볼 수 있게 미리 넘긴다(서버 확인은 기반 세션에 배정, 생기기 전에는 무시됨)
    await mutate("/api/seller/broadcast/end", { broadcastSessionId: sessionId }, "방송을 종료했습니다");
  };

  // 변경 조작은 요청 처리 중(busy)이거나 보이는 내용이 서버에서 확인된 최신이 아닐 때(stale) 모두 막는다.
  // 옛 version으로 보내 409가 나는 것을 원인에서 막는다. 「다시 불러오기」만 열어 둔다
  const locked = busy || stale;
  const snap = state.kind === "ok" ? state.snap : null;
  const live = snap?.broadcast ?? null;
  const opening = snap?.opening ?? null;
  const waiting = snap ? (live ? snap.waiting : snap.beforeBroadcast) : [];
  const next = waiting[0] ?? null;

  // HIT 카드 등록 대상: 지금 개봉 중(기본) → 방금 완료한 주문들
  const hitTargets: HitTarget[] = [
    ...(opening ? [{ queueItemId: opening.id, label: `${opening.nicknameSnapshot} · 지금 개봉 중` }] : []),
    ...(snap?.recentDone ?? []).slice(0, 5).map((d) => ({ queueItemId: d.id, label: `${d.nicknameSnapshot} · 방금 완료 (${kstTime(d.receivedAt)} 접수)` })),
  ];

  const act = async (item: QueueItem, action: "start" | "complete" | "revert", okText: string) => {
    const r = await mutate(`/api/seller/queue/${item.id}/${action}`, { expectedVersion: item.version }, okText);
    if (r.ok && action === "complete") doneSeenAt.current.set(item.id, performance.now());
    return r;
  };
  const setTimer = (item: QueueItem, seconds: number) =>
    mutate(`/api/seller/queue/${item.id}/timer`, { expectedVersion: item.version, timerSeconds: seconds }, seconds ? `타이머를 ${clock(seconds)}로 정했습니다` : "타이머를 껐습니다");
  const cancel = (item: QueueItem, reason: string) =>
    mutate(`/api/seller/queue/${item.id}/cancel`, { expectedVersion: item.version, reason }, "주문대기에서 취소했습니다");
  const move = (index: number, dir: -1 | 1) => {
    if (!snap) return;
    const ids = waiting.map((w) => w.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    void mutate("/api/seller/queue/reorder", { broadcastSessionId: live?.id ?? null, orderedIds: ids, expectedVersion: snap.version }, "순서를 바꿨습니다");
  };

  // 종료 확인 창이 열린 사이 다른 화면에서 방송이 바뀌면(끝나거나 새 방송) 창을 닫는다
  useEffect(() => {
    if (modal?.kind !== "end" || state.kind !== "ok" || busy) return;
    if (state.snap.broadcast?.id !== modal.sessionId) {
      setModal(null);
      setToast({ text: "다른 화면에서 방송이 바뀌었습니다. 최신 내용을 확인한 뒤 다시 종료해 주십시오", neg: true });
    }
  }, [modal, state, busy]);

  // 단축키(모두 Ctrl 조합): 개봉 시작·완료 Ctrl+Enter, 타이머 +30초 Ctrl+↑, 취소 Ctrl+Backspace(확인 창)
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    // 길게 눌러 생기는 자동 반복(e.repeat)은 무시한다(완료 뒤 다음 주문이 개봉되거나 타이머가 계속 오르지 않게)
    if (e.repeat || !e.ctrlKey || e.altKey || e.metaKey || modal || locked || !snap || typing(e.target)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (opening) void act(opening, "complete", "개봉을 완료했습니다");
      else if (live && next) void act(next, "start", "개봉을 시작했습니다");
    } else if ((e.key === "h" || e.key === "H") && live) {
      e.preventDefault();
      setModal({ kind: "hit" });
    } else if (e.key === "ArrowUp" && opening) {
      e.preventDefault();
      void setTimer(opening, Math.min(TIMER_MAX_SECONDS, opening.timerSeconds + TIMER_STEP));
    } else if (e.key === "Backspace" && opening) {
      e.preventDefault();
      setModal({ kind: "cancel", item: opening });
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <>
      <Topbar
        crumb="방송 › 방송 대시보드"
        badge={
          live ? (
            <span className="bdg b-live" data-testid="bc-live-badge">
              방송 중
            </span>
          ) : undefined
        }
      />
      <main className="main">
        <PageHead
          title="방송 대시보드"
          path={["방송", "방송 대시보드"]}
          actions={
            <>
              {allowed && (
                <button className="btn" type="button" data-testid="bc-hit-open" disabled={!live || locked} title={live ? undefined : "방송 중에만 등록할 수 있습니다"} onClick={() => setModal({ kind: "hit" })}>
                  HIT 카드 등록 <span className="kbd">Ctrl+H</span>
                </button>
              )}
              <Link className="btn btn-out" href="/seller/overlay">
                오버레이 주소
              </Link>
            </>
          }
        />

        {!allowed ? (
          <div className="card">
            <NoPermission need="방송 진행" />
          </div>
        ) : !snap ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" &&
              (state.status === 402 ? (
                <Locked />
              ) : state.status === 403 && state.error === "plan_feature_required" ? (
                <div className="st" style={{ boxShadow: "none" }}>
                  <span className="t">현재 플랜에서 제공하지 않는 기능입니다</span>
                </div>
              ) : state.status === 403 ? (
                <NoPermission need="방송 진행" />
              ) : (
                <ErrorState title="주문대기를 불러오지 못했습니다" onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="bc-grid">
            <div className="col" style={{ gap: 16, minWidth: 0 }}>
              {stale && (
                <div className="msg msg-cau row between" role="status" data-testid="bc-stale" style={{ gap: 8, flexWrap: "wrap" }}>
                  <span>최신 주문대기를 불러오지 못했습니다. 다시 불러오기 전까지 변경할 수 없습니다.</span>
                  <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>
                    다시 불러오기
                  </button>
                </div>
              )}

              <section className="bc-sum" aria-label="방송 요약" data-testid="bc-summary">
                <div className="bc-sum-t t-c1 c-alt">{sum?.broadcast ? (sum.broadcast.status === "live" ? "지금 방송" : "오늘 마지막 방송") : "오늘 방송 없음"}</div>
                <div className="bc-sum-g">
                  <SumTile label="주문" value={sum ? `${sum.summary.orders.toLocaleString("ko-KR")}건` : "-"} />
                  <SumTile label="매출" value={sum ? won(sum.summary.sales) : "-"} />
                  <SumTile label="완료 / 취소" value={sum ? `${sum.summary.completed} / ${sum.summary.cancelled}` : "-"} />
                  <SumTile label="HIT" value={sum ? `${sum.summary.hits}장` : "-"} />
                </div>
              </section>

              {/* 방송 시작·종료 */}
              <section className="card pad bc-live" aria-label="방송 상태">
                {live ? (
                  <div className="row between" style={{ gap: 12, flexWrap: "wrap" }}>
                    <div className="col" style={{ gap: 2, minWidth: 0 }}>
                      <span className="row t-hl2" style={{ gap: 8 }}>
                        <span className="dot dot-live" aria-hidden="true" />
                        <span className="ell" data-testid="bc-title">
                          {live.title || "제목 없는 방송"}
                        </span>
                      </span>
                      <span className="t-c1 c-alt">{kstTime(live.startedAt)} 시작</span>
                    </div>
                    <button className="btn btn-out" type="button" disabled={locked} onClick={() => live && setModal({ kind: "end", sessionId: live.id })}>
                      방송 종료
                    </button>
                  </div>
                ) : (
                  <form
                    className="row bc-start"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void mutate("/api/seller/broadcast/start", { title: title.trim() || undefined }, "방송을 시작했습니다").then((r) => r.ok && setTitle(""));
                    }}
                  >
                    <label className="sr" htmlFor="bc-title-input">
                      방송 제목
                    </label>
                    <input id="bc-title-input" className="inp" placeholder="방송 제목 (선택)" maxLength={100} value={title} disabled={locked} onChange={(e) => setTitle(e.target.value)} />
                    <button className="btn" type="submit" disabled={locked}>
                      방송 시작
                    </button>
                  </form>
                )}
                {yt && (
                  <div className="row bc-chat" style={{ gap: 8, flexWrap: "wrap" }} data-testid="bc-chat-bar">
                    {yt.live ? (
                      <>
                        <label className="row" style={{ gap: 6 }}>
                          <input
                            type="checkbox"
                            data-testid="bc-chat-toggle"
                            checked={yt.live.chatEnabled}
                            disabled={chatBusy}
                            onChange={(e) => (e.target.checked ? setModal({ kind: "chat-on" }) : void setChatEnabled(false))}
                          />
                          유튜브 채팅 수집
                        </label>
                        <span className="t-c1 c-alt">{yt.live.chatEnabled ? "켬 · 주문대기에 채팅 확인 여부를 표시만 합니다" : "끔 · 기본은 끔입니다"}</span>
                      </>
                    ) : (
                      <>
                        <span className="t-c1 c-alt">유튜브 방송을 연결하면 채팅을 모을 수 있습니다</span>
                        <Link className="btn btn-sm btn-out" href="/seller/youtube">
                          유튜브 연결
                        </Link>
                      </>
                    )}
                  </div>
                )}
              </section>

              {/* 개봉 중 */}
              <section className="card pad col" style={{ gap: 12 }} aria-labelledby="bc-opening-h">
                <h2 className="t-hl1" id="bc-opening-h">
                  개봉 중
                </h2>
                {opening ? (
                  <OpeningPanel
                    item={opening}
                    now={now}
                    busy={locked}
                    onComplete={() => void act(opening, "complete", "개봉을 완료했습니다")}
                    onTimer={() => setModal({ kind: "timer", item: opening })}
                    onCancel={() => setModal({ kind: "cancel", item: opening })}
                  />
                ) : live && next ? (
                  <div className="col" style={{ gap: 10 }}>
                    <span className="t-l2 c-alt">
                      다음 순서: <b className="c-pri">{next.nicknameSnapshot}</b> · {next.productLabel} ×{next.quantity}
                    </span>
                    <button className="btn btn-xl btn-block bc-big" type="button" disabled={locked} onClick={() => void act(next, "start", "개봉을 시작했습니다")}>
                      개봉 시작 <span className="kbd">Ctrl+Enter</span>
                    </button>
                  </div>
                ) : (
                  <span className="t-l2 c-alt" data-testid="bc-opening-empty">
                    {live ? "대기 중인 주문이 없습니다" : "방송을 시작하면 개봉할 수 있습니다"}
                  </span>
                )}
              </section>

              {/* 대기 */}
              <section className="card pad col" style={{ gap: 12 }} aria-labelledby="bc-waiting-h">
                <h2 className="t-hl1" id="bc-waiting-h">
                  {live ? "대기" : "방송 전 대기"} <span className="c-alt fw5">{waiting.length}건</span>
                </h2>
                {!live && waiting.length > 0 && <span className="t-c1 c-alt">방송을 시작하면 이 순서대로 방송에 들어갑니다</span>}
                {waiting.length === 0 ? (
                  <span className="t-l2 c-alt">대기 중인 주문이 없습니다</span>
                ) : (
                  <div className="au-lt-wrap">
                    <table className="tbl bc-tbl">
                      <thead>
                        <tr>
                          <th style={{ width: 48 }}>순서</th>
                          <th style={{ width: 80 }}>접수</th>
                          <th>구매자 · 상품</th>
                          {chatOn && (
                            <th style={{ width: 150 }} data-testid="bc-chat-head">
                              채팅
                            </th>
                          )}
                          <th style={{ width: 70 }}>타이머</th>
                          <th style={{ width: 240 }}>관리</th>
                        </tr>
                      </thead>
                      <tbody data-testid="bc-waiting">
                        {waiting.map((w, i) => (
                          <tr key={w.id}>
                            <td className="num">{i + 1}</td>
                            <td className="num">{kstTime(w.receivedAt)}</td>
                            <td className="col-text">
                              <ItemText item={w} />
                            </td>
                            {chatOn && (
                              <td className="t-c1 col-text" data-testid="bc-chat-cell">
                                {chatText(chat.get(w.nicknameSnapshot))}
                              </td>
                            )}
                            <td className="num">{w.timerSeconds > 0 ? clock(w.timerSeconds) : "-"}</td>
                            <td>
                              <span className="row bc-acts">
                                <button className="btn btn-sm btn-ghost" type="button" aria-label={`${w.nicknameSnapshot} 위로`} disabled={locked || i === 0} onClick={() => move(i, -1)}>
                                  ↑
                                </button>
                                <button className="btn btn-sm btn-ghost" type="button" aria-label={`${w.nicknameSnapshot} 아래로`} disabled={locked || i === waiting.length - 1} onClick={() => move(i, 1)}>
                                  ↓
                                </button>
                                <button className="btn btn-sm btn-out" type="button" disabled={locked} onClick={() => setModal({ kind: "timer", item: w })}>
                                  타이머
                                </button>
                                <button className="btn btn-sm btn-out" type="button" disabled={locked} onClick={() => setModal({ kind: "cancel", item: w })}>
                                  취소
                                </button>
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* 최근 완료 */}
              <section className="card pad col" style={{ gap: 12 }} aria-labelledby="bc-done-h">
                <h2 className="t-hl1" id="bc-done-h">
                  최근 완료
                </h2>
                {snap.recentDone.length === 0 ? (
                  <span className="t-l2 c-alt">완료한 주문이 없습니다</span>
                ) : (
                  <div className="au-lt-wrap">
                    <table className="tbl bc-tbl">
                      <thead>
                        <tr>
                          <th style={{ width: 70 }}>시각</th>
                          <th>구매자 · 상품</th>
                          <th style={{ width: 70 }}>결과</th>
                          <th style={{ width: 90 }}>관리</th>
                        </tr>
                      </thead>
                      <tbody data-testid="bc-done">
                        {snap.recentDone.map((d) => {
                          const seenAt = doneSeenAt.current.get(d.id);
                          const canRevert = live && d.broadcastSessionId === live.id && !opening && seenAt !== undefined && performance.now() - seenAt < REVERT_WINDOW_MS;
                          return (
                            <tr key={d.id}>
                              <td className="num">{d.doneAt ? kstTime(d.doneAt) : "-"}</td>
                              <td className="col-text">
                                <ItemText item={d} />
                              </td>
                              <td>
                                <span className="bdg b-done">완료</span>
                              </td>
                              <td>
                                {canRevert && (
                                  <button className="btn btn-sm btn-out" type="button" disabled={locked} onClick={() => void act(d, "revert", "완료를 되돌렸습니다")}>
                                    되돌리기
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>

            <aside className="col bc-side" style={{ gap: 16 }}>
            <section className="card pad col" style={{ gap: 10 }} aria-labelledby="bc-ov-h">
              <h2 className="t-hl2" id="bc-ov-h">
                오버레이
              </h2>
              <span className="t-c1 c-alt">OBS 브라우저 소스에 넣는 주소는 발급할 때 한 번만 보입니다. 잃어버리면 다시 발급해 주십시오.</span>
              <Link className="btn btn-sm btn-out" href="/seller/overlay">
                오버레이 주소 발급
              </Link>
            </section>
            <section className="card pad col bc-keys" style={{ gap: 10 }} aria-labelledby="bc-keys-h">
              <h2 className="t-hl2" id="bc-keys-h">
                단축키
              </h2>
              <dl className="kv">
                <dt>개봉 시작 · 완료</dt>
                <dd>
                  <span className="kbd">Ctrl+Enter</span>
                </dd>
                <dt>HIT 카드 등록</dt>
                <dd>
                  <span className="kbd">Ctrl+H</span>
                </dd>
                <dt>타이머 +30초</dt>
                <dd>
                  <span className="kbd">Ctrl+↑</span>
                </dd>
                <dt>개봉 중 취소</dt>
                <dd>
                  <span className="kbd">Ctrl+Backspace</span>
                </dd>
              </dl>
              <span className="t-c1 c-alt">입력칸에 글자를 입력하는 중에는 단축키가 동작하지 않습니다</span>
            </section>
            </aside>
          </div>
        )}
      </main>

      {modal?.kind === "end" && (
        <EndBroadcastModal
          waiting={snap?.waiting.length ?? 0}
          busy={busy}
          blocked={stale}
          onClose={() => setModal(null)}
          onConfirm={() => void endBroadcast(modal.sessionId)}
        />
      )}
      {modal?.kind === "cancel" && <CancelItemModal item={modal.item} busy={busy} blocked={stale} onClose={() => setModal(null)} onConfirm={(reason) => void cancel(modal.item, reason)} />}
      {modal?.kind === "hit" && (
        <HitCardModal
          targets={hitTargets}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            setToast({ text: "HIT 카드를 등록했습니다. 오버레이에 바로 나옵니다" });
            void load();
          }}
        />
      )}
      {modal?.kind === "chat-on" && yt && (
        <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="bc-chat-title">
          <div className="modal">
            <div className="modal-h">
              <h2 className="t-h2" id="bc-chat-title">
                유튜브 채팅 수집을 켜시겠습니까?
              </h2>
              <span className="t-l2 c-alt" data-testid="bc-chat-notice">
                {yt.chatNotice}
              </span>
            </div>
            <div className="modal-f">
              <button className="btn btn-out" type="button" disabled={chatBusy} onClick={() => setModal(null)}>
                닫기
              </button>
              <button className="btn" type="button" disabled={chatBusy} onClick={() => void setChatEnabled(true)}>
                켜기
              </button>
            </div>
          </div>
        </div>
      )}
      {modal?.kind === "timer" && <TimerModal item={modal.item} busy={busy} blocked={stale} onClose={() => setModal(null)} onConfirm={(s) => void setTimer(modal.item, s)} />}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

// 서버는 방송 시간 안에 들어온 주문만 채팅과 맞춰 본다. 그 밖(방송 전 주문)은 확인 대상이 아니라 「-」로 두어 「채팅 없음」으로 오해하지 않게 한다
function chatText(c: ChatMatch | undefined): string {
  if (!c) return "-";
  return c.matched ? `채팅 확인됨${c.lastChatAt ? ` · 마지막 ${kstTime(c.lastChatAt)}` : ""}` : "채팅 없음";
}

function SumTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="t-l2 c-alt">{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}

function ItemText({ item }: { item: QueueItem }) {
  return (
    <span className="col bc-item">
      <span className="t-l1 fw6 ell">
        {item.nicknameSnapshot}
        {item.gradeSnapshot && <span className="t-c1 c-alt fw5"> · {item.gradeSnapshot}</span>}
      </span>
      <span className="t-c1 c-alt ell">
        {item.productLabel} ×{item.quantity}
      </span>
    </span>
  );
}

function OpeningPanel({ item, now, busy, onComplete, onTimer, onCancel }: { item: QueueItem; now: number; busy: boolean; onComplete: () => void; onTimer: () => void; onCancel: () => void }) {
  const c = openingClock(item, now);
  return (
    <div className="col" style={{ gap: 12 }} data-testid="bc-opening">
      <div className="row between" style={{ gap: 12, flexWrap: "wrap" }}>
        <span className="col" style={{ gap: 2, minWidth: 0 }}>
          <span className="t-h2 ell">{item.nicknameSnapshot}</span>
          <span className="t-l2 c-alt ell">
            {item.productLabel} ×{item.quantity}
          </span>
        </span>
        <span className="col bc-clock" aria-live="off">
          <span className="t-c1 c-alt">{c.label}</span>
          <span className={`t-t2 num${c.over ? " c-neg" : ""}`}>{c.text}</span>
        </span>
      </div>
      <button className="btn btn-xl btn-block bc-big" type="button" disabled={busy} onClick={onComplete}>
        개봉 완료 <span className="kbd">Ctrl+Enter</span>
      </button>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-out" type="button" disabled={busy} onClick={onTimer}>
          타이머 <span className="kbd">Ctrl+↑ +30초</span>
        </button>
        <button className="btn btn-out" type="button" disabled={busy} onClick={onCancel}>
          취소 <span className="kbd">Ctrl+Backspace</span>
        </button>
      </div>
    </div>
  );
}
