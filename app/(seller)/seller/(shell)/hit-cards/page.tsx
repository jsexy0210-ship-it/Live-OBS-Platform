"use client";

import "../../../../../styles/seller-broadcast.css";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListTable, CursorPagination, ListHead, PageHead, SearchBox, SearchRow } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { useScrollRestore } from "../../../../../lib/client/navigation";
import { effectiveRange, listDefaults, type PeriodFilter } from "../../../../../lib/client/filterDefaults";
import { useListFilters } from "../../../../(admin)/admin/_components/useListFilters";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { SourceBadge } from "../../../../../components/seller/broadcast/SourceBadge";
import { HIT_GRADES } from "../../../../../components/seller/broadcast/hit";
import { formatDateTime } from "../../../../../lib/client/format";
import { DatePicker } from "../../../../../components/admin-ui/DatePicker";

// SA-053 HIT 카드 기록(방송 중 등록한 당첨 카드). 조회·등록·해제.
// API: GET /api/seller/hit-cards?from=&to=&cursor=(KST 날짜, 최신순 10개) · POST /api/seller/hit-cards { cardName, note?, nickname } · DELETE /api/seller/hit-cards/{id}
// 해제하면 오버레이에서도 사라진다. 방송별 걸러 보기·카드 등급·갤러리 보기는 서버에 자료가 없어 두지 않았다.

type Card = {
  id: string;
  cardName: string;
  note: string | null;
  nickname: string;
  grade: string | null;
  broadcast: { id: string; title: string | null } | null;
  order: { id: string; orderNo: string; productLabel: string } | null;
  // 외부 쇼핑몰 주문에서 나온 카드는 order가 없고 source가 "EXTERNAL"(직접 입력 카드는 null)
  source?: "INTERNAL" | "EXTERNAL" | null;
  createdAt: string;
};
type Page = { items: Card[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error"; status: number; error: string } | { kind: "ok"; items: Card[]; next: string | null };
type Filter = PeriodFilter & { grade?: string };

const query = (f: Filter, cursor?: string | null) => {
  const q = new URLSearchParams();
  const { from, to } = effectiveRange(f);
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  if (f.grade) q.set("grade", f.grade);
  if (cursor) q.set("cursor", cursor);
  const s = q.toString();
  return `/api/seller/hit-cards${s ? `?${s}` : ""}`;
};

export default function HitCardsPage() {
  const { can, me } = useSeller();
  const params = useSearchParams(), pathname = usePathname();
  const listHref = `${pathname}${params.size ? `?${params.toString()}` : ""}`;
  const detailHref = (id: string) => `/seller/hit-cards/${id}?${new URLSearchParams({ returnTo: listHref })}`;
  const allowed = can("BROADCAST_RUN");
  const [state, setState] = useState<Load>({ kind: "loading" });
  // 조회 조건은 주소(?from=&to=)가 기준이다: 상세 → ← 에서 그대로 돌아온다(docs/IA.md Back 규칙 3항)
  // 기본은 최근 1개월(목록 공통 규칙, lib/client/filterDefaults.ts). 기간을 비우고 검색하면 전체 기간. 서버는 아직 정렬·쪽 크기를 받지 않아 from·to만 보낸다
  const defaults = listDefaults({ grade: "" });
  const { applied, draft, setDraft, apply, reset } = useListFilters(defaults);
  // 업무 큐 링크(?period=all)로 들어오면 기간 칸은 비워 보인다(전체 기간)
  useEffect(() => {
    if (applied.period === "all") setDraft((d) => ({ ...d, from: "", to: "" }));
  }, [applied, setDraft]);
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const paging = useRef(false);
  const initialPaging = useRef(true);
  const pagingScope = useRef("");
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  // 조건이 바뀌면 마지막으로 보낸 조건의 응답만 반영한다
  const seq = useRef(0);

  const load = useCallback(async (f: Filter, restorePaging = false) => {
    const n = ++seq.current;
    paging.current = false;
    let scope = "";
    try { scope = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([me.sellerId, me.userId, query(f)])))), n => n.toString(16).padStart(2, "0")).join(""); } catch {}
    if (n !== seq.current) return;
    pagingScope.current = scope;
    let restore: { page: number; cursors: (string | undefined)[] } | undefined;
    if (restorePaging && scope) {
      try {
        const saved = JSON.parse(sessionStorage.getItem("onq:hit-cards:return") ?? "null");
        sessionStorage.removeItem("onq:hit-cards:return");
        if (saved?.scope === scope && Number.isInteger(saved.page) && saved.page >= 1 && Array.isArray(saved.cursors) && saved.page <= saved.cursors.length && saved.cursors[0] === null && saved.cursors.every((c: unknown, i: number) => i === 0 ? c === null : typeof c === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c))) restore = { page: saved.page, cursors: saved.cursors.map((c: string | null) => c ?? undefined) };
      } catch {}
    }
    setPage(restore?.page ?? 1); setCursors(restore?.cursors ?? [undefined]);
    setState({ kind: "loading" });
    const r = await api<Page>(query(f, restore?.cursors[restore.page - 1]));
    if (n !== seq.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.items, next: r.data.nextCursor } : { kind: "error", status: r.status, error: r.error });
  }, [me.sellerId, me.userId]);

  useEffect(() => {
    if (allowed) { const restore = initialPaging.current; initialPaging.current = false; void load(applied, restore); }
    return () => { seq.current++; };
  }, [allowed, applied, load]);
  const rememberPage = () => {
    if (!pagingScope.current) return;
    try { sessionStorage.setItem("onq:hit-cards:return", JSON.stringify({ scope: pagingScope.current, page, cursors: cursors.map(c => c ?? null) })); } catch {}
  };

  const turnPage = async (target: number) => {
    if (state.kind !== "ok" || paging.current || target === page || target < 1 || target > cursors.length + 1) return;
    const cursor = target <= cursors.length ? cursors[target - 1] : state.next;
    if (target > 1 && !cursor) return;
    paging.current = true; const n = ++seq.current;
    const r = await api<Page>(query(applied, cursor));
    if (n !== seq.current) return;
    paging.current = false;
    if (!r.ok) return setToast({ text: failMessage(r, "admin"), neg: true });
    setState({ kind: "ok", items: r.data.items, next: r.data.nextCursor });
    setPage(target); setCursors(c => {
      const visited = target > c.length ? [...c, cursor ?? undefined] : c;
      return visited[target] && visited[target] !== r.data.nextCursor ? visited.slice(0, target) : visited;
    });
  };

  const invalidRange = draft.from !== "" && draft.to !== "" && draft.from > draft.to;
  useScrollRestore("seller-hit-cards", state.kind === "ok");

  const search = () => {
    if (invalidRange) return setToast({ text: "시작일을 끝일보다 앞 날짜로 바꿔 주십시오", neg: true });
    apply({ ...applied, from: draft.from, to: draft.to, grade: draft.grade.trim(), period: "" });
  };

  const items = state.kind === "ok" ? state.items : [];

  return (
    <>
      <Topbar crumb="방송 › HIT 카드 기록" />
      <main className="main">
        <PageHead
          title="HIT 카드 기록"
          path={["방송", "HIT 카드 기록"]}
          actions={
            allowed && !me.readOnly && (
              <Link className="btn" href={detailHref("new")} onClick={rememberPage}>
                HIT 카드 기록하기
              </Link>
            )
          }
        />

        {!allowed ? (
          <div className="card">
            <NoPermission need="방송 진행" />
          </div>
        ) : (
          <>
            <SearchBox onSearch={search} onReset={reset} busy={state.kind === "loading"}>
              <SearchRow label="기간">
                <DatePicker aria-label="시작일" value={draft.from} onChange={(v) => setDraft({ ...draft, from: v })} />
                <span aria-hidden="true"> ~ </span>
                <DatePicker aria-label="종료일" value={draft.to} onChange={(v) => setDraft({ ...draft, to: v })} />
              </SearchRow>
              <SearchRow label="등급">
                <input className="inp" aria-label="등급" list="hit-grade-filter-list" maxLength={12} placeholder="전체 · 등급 입력" value={draft.grade} onChange={(e) => setDraft({ ...draft, grade: e.target.value })} />
                <datalist id="hit-grade-filter-list">
                  {HIT_GRADES.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </SearchRow>
            </SearchBox>

            <section className="au-list-section">
              {state.kind === "loading" && <div className="card"><LoadingRows rows={4} /></div>}
              {state.kind === "error" &&
                (state.status === 402 ? (
                  <div className="card"><Locked /></div>
                ) : state.status === 403 && state.error === "plan_feature_required" ? (
                  <div className="card"><div className="st" style={{ boxShadow: "none" }}>
                    <span className="t">지금 이용 중인 이용권에는 이 기능이 없습니다. 구독 화면에서 이용권을 바꾸면 사용할 수 있습니다</span>
                  </div></div>
                ) : state.status === 403 ? (
                  <NoPermission need="방송 진행" />
                ) : (
                  <div className="card"><ErrorState title="HIT 카드 기록을 불러오지 못했습니다" onRetry={() => void load(applied)} /></div>
                ))}
              {state.kind === "ok" && (
                <>
                  <ListHead total={items.length} unit="건 (현재 쪽)" />
                  {items.length === 0 ? (
                    <div className="card"><div className="st" style={{ boxShadow: "none" }} data-testid="hit-empty">
                      <span className="t">{applied.period !== "all" && !applied.grade && applied.from === defaults.from && applied.to === defaults.to ? "최근 1개월에는 HIT 카드 기록이 없습니다. 기간을 바꿔 다시 찾아 주십시오" : applied.grade || (applied.period !== "all" && (applied.from || applied.to)) ? "조건에 맞는 HIT 카드가 없습니다" : "아직 HIT 카드가 없습니다"}</span>
                      <span className="t-c1 c-alt">방송 대시보드에서 「HIT 카드 기록하기」로 추가해 주십시오</span>
                    </div></div>
                  ) : (
                    <ListTable>
                      <table className="tbl bc-tbl">
                        <thead>
                          <tr>
                            <th>카드</th>
                            <th style={{ width: 136 }}>일시</th>
                            <th style={{ width: 70 }}>등급</th>
                            <th style={{ width: 130 }}>구매자</th>
                            <th style={{ width: 200 }}>주문</th>
                            <th style={{ width: 140 }}>방송</th>
                            <th style={{ width: 80 }}>관리</th>
                          </tr>
                        </thead>
                        <tbody data-testid="hit-list">
                          {items.map((c) => (
                            <tr key={c.id}>
                              <td className="col-text">
                                <span className="col bc-item">
                                  <span className="t-l1 fw6 ell">{c.cardName}</span>
                                  {c.note && <span className="t-c1 c-alt ell">{c.note}</span>}
                                </span>
                              </td>
                              <td className="num">{formatDateTime(c.createdAt)}</td>
                              <td data-testid="hit-grade">{c.grade ?? "-"}</td>
                              <td className="ell">{c.nickname}</td>
                              <td className="ell col-text">{c.order ? `${c.order.orderNo} · ${c.order.productLabel}` : c.source === "EXTERNAL" ? <SourceBadge source={c.source} /> : "-"}</td>
                              <td className="ell col-text">{c.broadcast ? c.broadcast.title || "제목 없는 방송" : "-"}</td>
                              <td>
                                <span className="acts2">
                                  <Link className="btn btn-sm btn-out" href={detailHref(c.id)} onClick={rememberPage}>상세</Link>
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </ListTable>
                  )}
                  {(page > 1 || state.next) && <CursorPagination page={page} visited={cursors.length} hasNext={!!state.next} onChange={n => void turnPage(n)} onNext={() => void turnPage(page + 1)} />}
                </>
              )}
            </section>
          </>
        )}
      </main>

      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
