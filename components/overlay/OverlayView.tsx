"use client";

import "../../styles/overlay.css";
import { useCallback, useEffect, useRef, useState } from "react";

// OBS 오버레이 기본 템플릿 「주문대기 중심」(OV-001 세로 1080×1920 · OV-002 가로 1920×1080, 배경 투명).
// 위젯: 현재 주문 카드(개봉 중) · 주문대기 패널(다음 대기 주문, 건수 집계는 두지 않음 — DESIGN_PROMPT 「없애는 것」). 세로형은 위쪽 40% 안에, 가로형은 가운데를 비우고 왼쪽에 둔다.
// 상태: GET /api/overlay/{token}/state. 실시간 채널(stream, SSE)의 version이 바뀌면 다시 읽고, 끊겨도 15초마다 version을 확인한다.
// 토큰이 폐기(재발급)되거나 쇼핑몰이 잠기면 서버가 404를 준다 → 주문 표시를 지우고 주소 확인 안내만 남긴다(OV-006).
// 명예의 전당·공지 배너·쇼핑몰 주소·시각·HIT 카드 연출은 편집기(SA-051)·HIT 카드 API가 생긴 뒤 붙인다.

type Item = { id: string; nickname: string; gradeSnapshot: string | null; productLabel: string; quantity: number };
type State = { version: number; live: boolean; opening: Item | null; waiting: Item[] };
type View = { kind: "loading" } | { kind: "gone" } | { kind: "offline" } | { kind: "ok"; state: State; offline: boolean };

const POLL_MS = 15_000;

// 연결 실패: 그린 화면이 있으면 그대로 두고 안내만 더하고, 아직 한 번도 못 그렸으면 안내만 보인다(OV-006). 주소가 바뀐 상태는 그대로 둔다
const offline = (v: View): View => (v.kind === "ok" ? { ...v, offline: true } : v.kind === "gone" ? v : { kind: "offline" });
const QUEUE_ROWS = { portrait: 4, landscape: 5 };

export function OverlayView({ token, landscape }: { token: string; landscape: boolean }) {
  const base = `/api/overlay/${encodeURIComponent(token)}`;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [scale, setScale] = useState(1);
  const W = landscape ? 1920 : 1080;
  const H = landscape ? 1080 : 1920;

  // 늦게 온 옛 응답이 새 상태를 덮지 않게 보낸 순서로 거른다
  const sent = useRef(0);
  const applied = useRef(0);
  const version = useRef<number | null>(null);
  // 연결이 끊겼다고 표시한 동안에는 version이 그대로여도 다시 읽어 안내를 거둔다(회복 뒤 같은 version이 와도)
  const isOffline = useRef(false);
  const markOffline = useCallback(() => {
    isOffline.current = true;
    setView(offline);
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
      return setView({ kind: "gone" });
    }
    if (!res.ok) return markOffline();
    const state = (await res.json().catch(() => null)) as State | null;
    if (!state || n <= applied.current) return;
    applied.current = n;
    version.current = state.version;
    isOffline.current = false;
    setView({ kind: "ok", state, offline: false });
  }, [base, markOffline]);

  useEffect(() => {
    void load();
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
      es.addEventListener("error", () => void load());
    }
    const poll = setInterval(() => {
      fetch(`${base}/version`, { cache: "no-store" })
        .then(async (r) => (r.status === 404 ? onVersion(null) : r.ok ? onVersion(((await r.json()) as { version?: unknown }).version) : undefined))
        .catch(markOffline);
    }, POLL_MS);
    return () => {
      es?.close();
      clearInterval(poll);
    };
  }, [base, load]);

  // OBS 브라우저 소스(1080×1920·1920×1080)에서는 1배, 다른 크기 창에서는 비율을 지켜 맞춘다
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [W, H]);

  const state = view.kind === "ok" ? view.state : null;
  const rows = state ? state.waiting.slice(0, landscape ? QUEUE_ROWS.landscape : QUEUE_ROWS.portrait) : [];

  return (
    <div className="ovl-root">
      <div className={`ovl ${landscape ? "ovl-land" : "ovl-port"}`} style={{ width: W, height: H, transform: `scale(${scale})` }} data-testid="overlay">
        {view.kind === "offline" && (
          <div className="ovl-pill ovl-notice" role="status" data-testid="overlay-offline">
            연결이 끊겼어요. 다시 연결하는 중이에요
          </div>
        )}
        {view.kind === "gone" && (
          <div className="ovl-pill ovl-notice" role="status" data-testid="overlay-gone">
            오버레이 주소가 바뀌었어요. 파트너스 관리자에서 새 주소를 넣어 주세요
          </div>
        )}
        {state && (
          <div className="ovl-stack">
            {view.kind === "ok" && view.offline && (
              <div className="ovl-pill" role="status" data-testid="overlay-offline">
                연결이 끊겼어요. 다시 연결하는 중이에요
              </div>
            )}
            {!state.live && !state.opening && (
              <div className="ovl-pill" data-testid="overlay-idle">
                방송 준비 중이에요
              </div>
            )}
            {state.opening && (
              <section className="ovl-card" aria-label="현재 주문" data-testid="overlay-opening">
                {state.opening.gradeSnapshot && <span className="ovl-grade">{state.opening.gradeSnapshot}</span>}
                <span className="ovl-cur-nm">{state.opening.nickname}</span>
                <span className="ovl-cur-pd">
                  {state.opening.productLabel} ×{state.opening.quantity}
                </span>
              </section>
            )}
            {state.live && (
              <section className="ovl-queue" aria-label="주문대기" data-testid="overlay-queue">
                <span className="ovl-q-h">주문대기</span>
                {rows.length === 0 ? (
                  <span className="ovl-q-empty">대기 중인 주문이 없어요</span>
                ) : (
                  <ol className="ovl-q-list">
                    {rows.map((w, i) => (
                      <li key={w.id} className="ovl-q-row">
                        <span className="ovl-q-no">{i + 1}</span>
                        <span className="ovl-q-tx">
                          <span className="ovl-q-nm">{w.nickname}</span>
                          <span className="ovl-q-pd">
                            {w.productLabel} ×{w.quantity}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
