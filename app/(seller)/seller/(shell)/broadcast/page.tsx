"use client";

import "../../../../../styles/seller-broadcast.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { CancelItemModal, EndBroadcastModal, TimerModal } from "../../../../../components/seller/broadcast/Modals";
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
type Modal = { kind: "end" } | { kind: "cancel"; item: QueueItem } | { kind: "timer"; item: QueueItem } | null;

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

  // 다시 읽기 반영 규칙(latestResponse.ts): 나중에 보낸 요청의 성공만 반영하고, 실패가 앞선 성공을 버리지 않는다
  const reads = useLatestResponse();
  const version = useRef<number | null>(null);
  const load = useCallback(async () => {
    const t = reads.next();
    const r = await api<Snapshot>("/api/seller/queue");
    if (!r.ok) {
      if (reads.hasApplied()) return reads.failMatters(t) ? setStale(true) : undefined;
      return setState({ kind: "error", status: r.status, error: r.error });
    }
    const verdict = reads.accept(t);
    // 변경 전에 보낸 읽기가 늦게 왔으면 버린다(변경 뒤 다시 읽기가 반영한다. 그 읽기가 실패했으면 낡음 안내가 남는다)
    if (verdict !== "apply") return;
    version.current = r.data.version;
    setStale(false);
    setState({ kind: "ok", snap: r.data });
  }, [reads]);

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

  // 타이머·되돌리기 표시용 시계
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // 변경 요청 공통 처리: 성공·거부 모두 다시 읽어 서버 상태로 맞춘다. 불분명하면 성공을 추정하지 않는다.
  // 다시 읽기가 끝날 때까지 조작을 막는다(옛 version으로 다음 요청을 보내 409가 나지 않게).
  // 서버가 바뀌었을(수 있는) 요청 뒤에는 그 전에 보낸 읽기 응답이 늦게 와도 반영하지 않는다(confirmChange).
  const mutate = useCallback(
    async <T,>(path: string, body: unknown, okText: string): Promise<ApiResult<T>> => {
      setBusy(true);
      const r = await api<T>(path, { method: "POST", body });
      if (r.ok) {
        reads.confirmChange();
        setModal(null);
        setToast({ text: okText });
      } else if (isUnclearFailure(r.status)) {
        reads.confirmChange();
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

  const snap = state.kind === "ok" ? state.snap : null;
  const live = snap?.broadcast ?? null;
  const opening = snap?.opening ?? null;
  const waiting = snap ? (live ? snap.waiting : snap.beforeBroadcast) : [];
  const next = waiting[0] ?? null;

  const act = (item: QueueItem, action: "start" | "complete" | "revert", okText: string) =>
    mutate(`/api/seller/queue/${item.id}/${action}`, { expectedVersion: item.version }, okText);
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

  // 단축키(모두 Ctrl 조합): 개봉 시작·완료 Ctrl+Enter, 타이머 +30초 Ctrl+↑, 취소 Ctrl+Backspace(확인 창)
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    if (!e.ctrlKey || e.altKey || e.metaKey || modal || busy || !snap || typing(e.target)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (opening) void act(opening, "complete", "개봉을 완료했습니다");
      else if (live && next) void act(next, "start", "개봉을 시작했습니다");
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
        <div className="ph">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-t3">방송 대시보드</h1>
            <span className="t-l2 c-alt">결제된 주문이 들어온 순서대로 쌓입니다. 개봉 상태는 오버레이에 바로 반영됩니다.</span>
          </div>
        </div>

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
                  <span>최신 주문대기를 불러오지 못했습니다. 보이는 내용이 최신이 아닐 수 있습니다.</span>
                  <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>
                    다시 불러오기
                  </button>
                </div>
              )}

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
                    <button className="btn btn-out" type="button" disabled={busy} onClick={() => setModal({ kind: "end" })}>
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
                    <input id="bc-title-input" className="inp" placeholder="방송 제목 (선택)" maxLength={100} value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
                    <button className="btn" type="submit" disabled={busy}>
                      방송 시작
                    </button>
                  </form>
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
                    busy={busy}
                    onComplete={() => void act(opening, "complete", "개봉을 완료했습니다")}
                    onTimer={() => setModal({ kind: "timer", item: opening })}
                    onCancel={() => setModal({ kind: "cancel", item: opening })}
                  />
                ) : live && next ? (
                  <div className="col" style={{ gap: 10 }}>
                    <span className="t-l2 c-alt">
                      다음 순서: <b className="c-pri">{next.nicknameSnapshot}</b> · {next.productLabel} ×{next.quantity}
                    </span>
                    <button className="btn btn-xl btn-block bc-big" type="button" disabled={busy} onClick={() => void act(next, "start", "개봉을 시작했습니다")}>
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
                  <ol className="bc-list" data-testid="bc-waiting">
                    {waiting.map((w, i) => (
                      <li key={w.id} className="bc-row">
                        <span className="bc-no num">{i + 1}</span>
                        <ItemText item={w} />
                        <span className="row bc-acts">
                          {w.timerSeconds > 0 && <span className="t-c1 c-alt num">⏱ {clock(w.timerSeconds)}</span>}
                          <button className="btn btn-sm btn-ghost" type="button" aria-label={`${w.nicknameSnapshot} 위로`} disabled={busy || i === 0} onClick={() => move(i, -1)}>
                            ↑
                          </button>
                          <button className="btn btn-sm btn-ghost" type="button" aria-label={`${w.nicknameSnapshot} 아래로`} disabled={busy || i === waiting.length - 1} onClick={() => move(i, 1)}>
                            ↓
                          </button>
                          <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => setModal({ kind: "timer", item: w })}>
                            타이머
                          </button>
                          <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => setModal({ kind: "cancel", item: w })}>
                            취소
                          </button>
                        </span>
                      </li>
                    ))}
                  </ol>
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
                  <ul className="bc-list" data-testid="bc-done">
                    {snap.recentDone.map((d) => {
                      const canRevert = live && d.broadcastSessionId === live.id && !opening && d.doneAt && now - new Date(d.doneAt).getTime() < REVERT_WINDOW_MS;
                      return (
                        <li key={d.id} className="bc-row">
                          <span className="bdg b-done">완료</span>
                          <ItemText item={d} />
                          <span className="row bc-acts">
                            {d.doneAt && <span className="t-c1 c-alt num">{kstTime(d.doneAt)}</span>}
                            {canRevert && (
                              <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => void act(d, "revert", "완료를 되돌렸습니다")}>
                                되돌리기
                              </button>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>

            <aside className="card pad col bc-keys" style={{ gap: 10 }} aria-labelledby="bc-keys-h">
              <h2 className="t-hl2" id="bc-keys-h">
                단축키
              </h2>
              <dl className="kv">
                <dt>개봉 시작 · 완료</dt>
                <dd>
                  <span className="kbd">Ctrl+Enter</span>
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
            </aside>
          </div>
        )}
      </main>

      {modal?.kind === "end" && (
        <EndBroadcastModal
          waiting={snap?.waiting.length ?? 0}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={() => void mutate("/api/seller/broadcast/end", {}, "방송을 종료했습니다")}
        />
      )}
      {modal?.kind === "cancel" && <CancelItemModal item={modal.item} busy={busy} onClose={() => setModal(null)} onConfirm={(reason) => void cancel(modal.item, reason)} />}
      {modal?.kind === "timer" && <TimerModal item={modal.item} busy={busy} onClose={() => setModal(null)} onConfirm={(s) => void setTimer(modal.item, s)} />}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
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
        {item.productLabel} ×{item.quantity} · {kstTime(item.receivedAt)} 결제
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
