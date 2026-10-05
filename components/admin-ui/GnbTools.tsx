"use client";

// 관리자 상단 도구 둘: 전역 검색(돋보기)과 알림(종). 파트너스·마스터 관리자 셸이 함께 쓴다.
// 검색: GET {scope}/search?q= → 종류별 최대 5건 [{ id, title, sub, href }]. 알림: GET {scope}/notifications → { items, unreadCount }.
// 문구 말투는 관리자 화면(명사형·합니다체). 스타일: styles/seller.css (.gnb-ic · .gnb-pop)
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// 셸의 api()를 쓰지 않고 직접 읽는다: 검색이 요금제 때문에 막혀도(403) 요금제 안내 화면이 뜨지 않게 하고, 실패는 이 부품 안에서만 알린다.
// 로그인이 풀린 경우는 셸이 /me로 따로 처리한다.
async function fetcher<T>(path: string, init: { method?: string } = {}): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  try {
    const res = await fetch(path, { method: init.method ?? "GET", cache: "no-store" });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: (await res.json().catch(() => ({}))) as T };
  } catch {
    return { ok: false, status: 0 };
  }
}

type Hit = { id: string; title: string; sub: string; href: string };
type Notice = { id: string; kind: string; title: string; href: string; createdAt: string; unread: boolean };

const SEARCH_DELAY_MS = 300;
const MAX_Q = 50;

// 바깥을 누르거나 Esc를 누르면 닫는다. 닫으면 열었던 버튼으로 포커스를 돌린다
function usePopover(open: boolean, close: () => void, anchor: React.RefObject<HTMLElement | null>) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      anchor.current?.querySelector("button")?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, anchor]);
  return box;
}

const kst = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

export function GlobalSearch({ scope }: { scope: "seller" | "admin" }) {
  const groups: [string, string][] =
    scope === "admin"
      ? [["sellers", "파트너스"], ["orders", "주문"], ["payments", "결제"], ["inquiries", "문의"], ["jobs", "자동 작업"]]
      : [["products", "상품"], ["orders", "주문"], ["members", "회원"], ["inquiries", "문의"]];
  const hint = scope === "admin" ? "파트너스 · 주문번호 · 결제번호 · 문의 · 작업" : "상품 · 주문번호 · 회원 닉네임 · 문의";
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Record<string, Hit[]> }>({ kind: "idle" });
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);
  const close = useCallback(() => setOpen(false), []);
  const box = usePopover(open, close, wrap);

  const term = q.trim();
  useEffect(() => {
    if (!open) return;
    if (!term) return setState({ kind: "idle" });
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const t = setTimeout(async () => {
      const r = await fetcher<Record<string, Hit[]>>(`/api/${scope}/search?q=${encodeURIComponent(term)}`);
      if (id !== reqId.current) return;
      setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [term, open, scope]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const total = state.kind === "ok" ? groups.reduce((n, [k]) => n + (state.data[k]?.length ?? 0), 0) : 0;

  return (
    <div className="gnb-ic-wrap" ref={wrap}>
      <button className="gnb-ic" type="button" aria-label="빠른 찾기" aria-expanded={open} aria-haspopup="dialog" title="빠른 찾기" onClick={() => setOpen((v) => !v)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
      </button>
      {open && (
        <div className="gnb-pop" role="dialog" aria-label="전체 검색" ref={box}>
          <div className="gnb-pop-h">
            <input
              ref={input}
              className="inp inp-sm"
              type="search"
              role="searchbox"
              aria-label="전체 검색"
              placeholder={hint}
              maxLength={MAX_Q}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="gnb-pop-b" aria-live="polite">
            {state.kind === "idle" && <p className="gnb-pop-m">검색어를 입력해 주십시오.</p>}
            {state.kind === "loading" && <p className="gnb-pop-m">검색 중입니다.</p>}
            {state.kind === "error" && (
              <p className="gnb-pop-m">
                검색하지 못했습니다. 잠시 뒤 다시 시도해 주십시오.
              </p>
            )}
            {state.kind === "ok" && total === 0 && <p className="gnb-pop-m">「{term}」 검색 결과가 없습니다.</p>}
            {state.kind === "ok" &&
              groups.map(([key, label]) => {
                const rows = state.data[key] ?? [];
                if (rows.length === 0) return null;
                return (
                  <section key={key} className="gnb-pop-g" aria-label={label}>
                    <strong className="gnb-pop-gh">{label}</strong>
                    {rows.map((h) => (
                      <Link key={`${key}:${h.id}`} className="gnb-pop-i" href={h.href} onClick={close}>
                        <span className="gnb-pop-t ell">{h.title}</span>
                        <span className="gnb-pop-s ell">{h.sub}</span>
                      </Link>
                    ))}
                  </section>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}

export function NotificationBell({ scope, allHref }: { scope: "seller" | "admin"; allHref?: string }) {
  const kindLabel: Record<string, string> = {
    NOTICE: "공지",
    INQUIRY_REPLY: "문의 답변",
    INQUIRY_WAITING: "답변 대기",
    DEPOSIT_PENDING: "입금 확인",
    ORDER_PAID: "결제 완료",
    OUT_OF_STOCK: "재고 없음",
    RETURN_REQUESTED: "교환·반품",
  };
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ok"; items: Notice[]; unreadCount: number }>({ kind: "loading" });
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const box = usePopover(open, close, wrap);

  const load = useCallback(async () => {
    const r = await fetcher<{ items: Notice[]; unreadCount: number }>(`/api/${scope}/notifications`);
    setState(r.ok ? { kind: "ok", items: r.data.items, unreadCount: r.data.unreadCount } : { kind: "error" });
    return r.ok ? r.data.items : null;
  }, [scope]);

  useEffect(() => {
    void load();
    const again = () => document.visibilityState === "visible" && void load();
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [load]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    const items = await load();
    // 파트너스는 알림 센터를 열면 공지 알림이 읽음으로 남는다(문의 답변은 문의를 열어야 읽음)
    if (scope === "seller" && items?.some((n) => n.kind === "NOTICE" && n.unread)) {
      await fetcher("/api/seller/notifications/read", { method: "POST" });
      await load();
    }
  };

  const count = state.kind === "ok" ? state.unreadCount : 0;
  return (
    <div className="gnb-ic-wrap" ref={wrap}>
      <button className="gnb-ic" type="button" aria-label={count > 0 ? `알림 ${count}건` : "알림"} aria-expanded={open} aria-haspopup="dialog" title="알림" onClick={() => void toggle()}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
          <path d="M13.7 20a2 2 0 01-3.4 0" />
        </svg>
        {count > 0 && (
          <span className="gnb-badge" data-testid="bell-badge">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && (
        <div className="gnb-pop" role="dialog" aria-label="알림" ref={box}>
          <div className="gnb-pop-b">
            {state.kind === "loading" && <p className="gnb-pop-m">불러오는 중입니다.</p>}
            {state.kind === "error" && (
              <p className="gnb-pop-m">
                알림을 불러오지 못했습니다.{" "}
                <button className="btn btn-sm btn-text" type="button" onClick={() => void load()}>
                  다시 시도
                </button>
              </p>
            )}
            {state.kind === "ok" && state.items.length === 0 && <p className="gnb-pop-m">새 알림이 없습니다.</p>}
            {state.kind === "ok" &&
              state.items.map((n) => (
                <Link key={n.id} className={`gnb-pop-i${n.unread ? " unread" : ""}`} href={n.href} onClick={close}>
                  <span className="gnb-pop-t ell">
                    <b className="gnb-pop-k">{kindLabel[n.kind] ?? "알림"}</b> {n.title}
                  </span>
                  <span className="gnb-pop-s num">{kst(n.createdAt)}</span>
                </Link>
              ))}
          </div>
          {allHref && (
            <Link className="gnb-pop-all" href={allHref} onClick={close}>
              모두 보기
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
