"use client";

import "../../../../../styles/seller-broadcast.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListHead, Modal, PageHead, SearchBox, SearchRow } from "../../../../../components/admin-ui";
import { HitCardModal } from "../../../../../components/seller/broadcast/HitCardModal";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { SourceBadge } from "../../../../../components/seller/broadcast/SourceBadge";
import { kstTime } from "../../../../../components/seller/broadcast/queue";

// SA-053 HIT 카드 이력(방송 중 등록한 당첨 카드). 조회·등록·해제.
// API: GET /api/seller/hit-cards?from=&to=&cursor=(KST 날짜, 최신순 50개) · POST /api/seller/hit-cards { cardName, note?, nickname } · DELETE /api/seller/hit-cards/{id}
// 해제하면 오버레이에서도 사라진다. 방송별 걸러 보기·카드 등급·갤러리 보기는 서버에 자료가 없어 두지 않았다.

type Card = {
  id: string;
  cardName: string;
  note: string | null;
  nickname: string;
  broadcast: { id: string; title: string | null } | null;
  order: { id: string; orderNo: string; productLabel: string } | null;
  // 외부 쇼핑몰 주문에서 나온 카드는 order가 없고 source가 "EXTERNAL"(직접 입력 카드는 null)
  source?: "INTERNAL" | "EXTERNAL" | null;
  createdAt: string;
};
type Page = { items: Card[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error"; status: number; error: string } | { kind: "ok"; items: Card[]; next: string | null };
type Filter = { from: string; to: string };

const EMPTY: Filter = { from: "", to: "" };
const query = (f: Filter, cursor?: string | null) => {
  const q = new URLSearchParams();
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (cursor) q.set("cursor", cursor);
  const s = q.toString();
  return `/api/seller/hit-cards${s ? `?${s}` : ""}`;
};

// 한국 시간 월/일 시:분
const kstDate = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${kstTime(iso)}`;
};

export default function HitCardsPage() {
  const { can } = useSeller();
  const allowed = can("BROADCAST_RUN");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [draft, setDraft] = useState<Filter>(EMPTY);
  const [applied, setApplied] = useState<Filter>(EMPTY);
  const [more, setMore] = useState(false);
  const [modal, setModal] = useState<{ kind: "add" } | { kind: "delete"; card: Card } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  // 조건이 바뀌면 마지막으로 보낸 조건의 응답만 반영한다
  const seq = useRef(0);

  const load = useCallback(async (f: Filter) => {
    const n = ++seq.current;
    setState({ kind: "loading" });
    const r = await api<Page>(query(f));
    if (n !== seq.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.items, next: r.data.nextCursor } : { kind: "error", status: r.status, error: r.error });
  }, []);

  useEffect(() => {
    if (allowed) void load(applied);
  }, [allowed, applied, load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    const n = seq.current;
    setMore(true);
    const r = await api<Page>(query(applied, state.next));
    setMore(false);
    if (n !== seq.current) return;
    if (!r.ok) return setToast({ text: failMessage(r, "admin"), neg: true });
    setState({ kind: "ok", items: [...state.items, ...r.data.items.filter((c) => !state.items.some((o) => o.id === c.id))], next: r.data.nextCursor });
  };

  const invalidRange = draft.from !== "" && draft.to !== "" && draft.from > draft.to;
  const search = () => {
    if (invalidRange) return setToast({ text: "조회 기간의 시작일이 끝일보다 늦습니다", neg: true });
    setApplied({ ...draft });
  };
  const reset = () => {
    setDraft(EMPTY);
    setApplied(EMPTY);
  };

  const remove = async (card: Card) => {
    setBusy(true);
    const r = await api<{ ok: true }>(`/api/seller/hit-cards/${card.id}`, { method: "DELETE" });
    setBusy(false);
    // 이미 지워진 카드(404)는 목록만 다시 맞춘다
    if (!r.ok && r.status !== 404) return setToast({ text: failMessage(r, "admin"), neg: true });
    setModal(null);
    setToast({ text: "HIT 카드를 해제했습니다" });
    void load(applied);
  };

  const items = state.kind === "ok" ? state.items : [];

  return (
    <>
      <Topbar crumb="방송 › HIT 카드 이력" />
      <main className="main">
        <PageHead
          title="HIT 카드 이력"
          path={["방송", "HIT 카드 이력"]}
          actions={
            allowed && (
              <button className="btn" type="button" onClick={() => setModal({ kind: "add" })}>
                HIT 카드 등록
              </button>
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
                <input className="inp" type="date" aria-label="시작일" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
                <span aria-hidden="true"> ~ </span>
                <input className="inp" type="date" aria-label="종료일" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
              </SearchRow>
            </SearchBox>

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
                  <ErrorState title="HIT 카드 이력을 불러오지 못했습니다" onRetry={() => void load(applied)} />
                ))}
              {state.kind === "ok" && (
                <>
                  <ListHead total={items.length} unit={state.next ? "건 이상" : "건"} />
                  {items.length === 0 ? (
                    <div className="st" style={{ boxShadow: "none" }} data-testid="hit-empty">
                      <span className="t">{applied.from || applied.to ? "조건에 맞는 HIT 카드가 없습니다" : "아직 HIT 카드가 없습니다"}</span>
                      <span className="t-c1 c-alt">방송 중 「HIT 카드 등록」으로 추가해 주십시오</span>
                    </div>
                  ) : (
                    <div className="au-lt-wrap">
                      <table className="tbl bc-tbl">
                        <thead>
                          <tr>
                            <th style={{ width: 110 }}>일시</th>
                            <th>카드</th>
                            <th style={{ width: 130 }}>구매자</th>
                            <th style={{ width: 200 }}>주문</th>
                            <th style={{ width: 140 }}>방송</th>
                            <th style={{ width: 80 }}>관리</th>
                          </tr>
                        </thead>
                        <tbody data-testid="hit-list">
                          {items.map((c) => (
                            <tr key={c.id}>
                              <td className="num">{kstDate(c.createdAt)}</td>
                              <td className="col-text">
                                <span className="col bc-item">
                                  <span className="t-l1 fw6 ell">{c.cardName}</span>
                                  {c.note && <span className="t-c1 c-alt ell">{c.note}</span>}
                                </span>
                              </td>
                              <td className="ell">{c.nickname}</td>
                              <td className="ell col-text">{c.order ? `${c.order.orderNo} · ${c.order.productLabel}` : c.source === "EXTERNAL" ? <SourceBadge source={c.source} /> : "-"}</td>
                              <td className="ell col-text">{c.broadcast ? c.broadcast.title || "제목 없는 방송" : "-"}</td>
                              <td>
                                <button className="btn btn-sm btn-out" type="button" onClick={() => setModal({ kind: "delete", card: c })}>
                                  해제
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {state.next && (
                    <div className="row" style={{ justifyContent: "center", padding: 12 }}>
                      <button className="btn btn-out" type="button" disabled={more} onClick={() => void loadMore()}>
                        더 보기
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </main>

      {modal?.kind === "add" && (
        <HitCardModal
          targets={[]}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            setToast({ text: "HIT 카드를 등록했습니다" });
            void load(applied);
          }}
        />
      )}
      {modal?.kind === "delete" && (
        <Modal labelId="hit-del-title" busy={busy} onClose={() => setModal(null)}>
          <div className="modal-h">
            <h2 className="modal-t" id="hit-del-title">
              HIT 카드를 해제하시겠습니까?
            </h2>
            <span className="t-l2 c-alt">
              {modal.card.nickname} · {modal.card.cardName}
            </span>
          </div>
          <span className="t-l2">오버레이에서도 바로 사라집니다.</span>
          <div className="modal-f">
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => setModal(null)}>
              취소
            </button>
            <button className="btn btn-neg" type="button" disabled={busy} onClick={() => void remove(modal.card)}>
              해제
            </button>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
