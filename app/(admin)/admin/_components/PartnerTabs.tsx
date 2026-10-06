"use client";

import { ListTable, ListHead } from "../../../../components/admin-ui";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../lib/server/authz/permissions";
import { textLength } from "../../../../lib/server/text/clean";
import { Modal } from "../../../../components/admin-ui/Modal";
import { ErrorState, LoadingRows, Toast } from "../../../../components/seller/States";
import { adminApi, failMessage } from "./api";
import { useAdmin } from "./AdminShell";
import { dayTime, won } from "./partners";
import { DatePicker } from "../../../../components/admin-ui/DatePicker";

// 파트너스 상세(MA-012)의 탭 내용: 방송 이력·메모·결제 연결(PG)·활동 기록. 모두 서버가 주는 값만 보인다.
export const PARTNER_TABS = [
  ["info", "기본정보"],
  ["shop", "쇼핑몰"],
  ["subscription", "구독"],
  ["pg", "결제 연결"],
  ["broadcasts", "방송 이력"],
  ["orders", "주문 현황"],
  ["notes", "메모"],
  ["activity", "활동 기록"],
] as const;
export type PartnerTab = (typeof PARTNER_TABS)[number][0];

// ─── 방송 이력(GET /api/admin/sellers/{id}/broadcasts, 모든 마스터 역할) ───
type Broadcast = { id: string; title: string; status: "live" | "ended"; startedAt: string; endedAt: string | null; summary: { orders: number; paidOrders: number; sales: number; completed: number; cancelled: number; hits: number } };
type BcPage = { items: Broadcast[]; nextCursor: string | null };
type BcLoad = { kind: "loading" } | { kind: "error"; message?: string } | { kind: "ok"; items: Broadcast[]; next: string | null };

const bcUrl = (sellerId: string, f: { from: string; to: string }, cursor?: string) => {
  const p = new URLSearchParams();
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (cursor) p.set("cursor", cursor);
  return `/api/admin/sellers/${sellerId}/broadcasts?${p}`;
};

export function PartnerBroadcasts({ sellerId }: { sellerId: string }) {
  const [draft, setDraft] = useState({ from: "", to: "" });
  const [applied, setApplied] = useState({ from: "", to: "" });
  const [state, setState] = useState<BcLoad>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const reqId = useRef(0);
  const rangeError = !!draft.from && !!draft.to && draft.from > draft.to;
  const load = useCallback(
    async (f: { from: string; to: string }) => {
      const id = ++reqId.current;
      setMore(false);
      setState({ kind: "loading" });
      const r = await adminApi<BcPage>(bcUrl(sellerId, f));
      if (id !== reqId.current) return;
      setState(r.ok ? { kind: "ok", items: r.data.items, next: r.data.nextCursor } : { kind: "error", message: r.error === "invalid_range" ? r.message : undefined });
    },
    [sellerId],
  );
  useEffect(() => void load(applied), [applied, load]);
  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await adminApi<BcPage>(bcUrl(sellerId, applied, state.next));
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ kind: "ok", items: [...state.items, ...r.data.items], next: r.data.nextCursor });
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오.");
  };

  return (
    <section className="au-list-section" style={{ gap: 14 }} aria-label="방송 이력" data-testid="tab-broadcasts">
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <DatePicker aria-label="방송 시작일 부터" value={draft.from} onChange={(v) => setDraft({ ...draft, from: v })} />
        <span aria-hidden="true">~</span>
        <DatePicker aria-label="방송 시작일 까지" value={draft.to} onChange={(v) => setDraft({ ...draft, to: v })} />
        <button className="btn btn-sm" type="button" disabled={rangeError} onClick={() => setApplied(draft)}>
          조회
        </button>
        <button className="btn btn-sm btn-out" type="button" onClick={() => { setDraft({ from: "", to: "" }); setApplied({ from: "", to: "" }); }}>
          초기화
        </button>
        {rangeError && (
          <span className="err" role="alert">
            시작일이 종료일보다 늦습니다.
          </span>
        )}
      </div>
      {state.kind === "loading" && <LoadingRows rows={4} />}
      {state.kind === "error" && <ErrorState title={state.message ?? "방송 이력을 불러오지 못했습니다."} onRetry={() => void load(applied)} />}
      {state.kind === "ok" &&
        (state.items.length === 0 ? (
          <div className="st">
            <span className="t">방송 이력이 없습니다.</span>
          </div>
        ) : (
          <>
            <>
              <ListHead total={state.items.length} loaded />
              <ListTable>
              <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                <thead>
                  <tr>
                    <th>시작</th>
                    <th>종료</th>
                    <th>방송 제목</th>
                    <th>상태</th>
                    <th>주문</th>
                    <th>결제된 주문</th>
                    <th>매출</th>
                    <th>완료</th>
                    <th>취소</th>
                    <th>조회</th>
                  </tr>
                </thead>
                <tbody>
                  {state.items.map((b) => (
                    <tr key={b.id} data-testid="broadcast-row">
                      <td>{dayTime(b.startedAt)}</td>
                      <td>{dayTime(b.endedAt)}</td>
                      <td className="col-text">{b.title}</td>
                      <td>
                        <span className={`bdg ${b.status === "live" ? "b-info" : "b-gray"}`}>{b.status === "live" ? "방송 중" : "종료"}</span>
                      </td>
                      <td>{b.summary.orders.toLocaleString("ko-KR")}</td>
                      <td>{b.summary.paidOrders.toLocaleString("ko-KR")}</td>
                      <td>{won(b.summary.sales)}</td>
                      <td>{b.summary.completed.toLocaleString("ko-KR")}</td>
                      <td>{b.summary.cancelled.toLocaleString("ko-KR")}</td>
                      <td>{b.summary.hits.toLocaleString("ko-KR")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ListTable>
            </>
            {state.next && (
              <div className="row" style={{ justifyContent: "center" }}>
                <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                  {more ? "불러오는 중" : "더 보기"}
                </button>
              </div>
            )}
          </>
        ))}
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </section>
  );
}

// ─── 메모(GET·POST /api/admin/sellers/{id}/notes, DELETE …/notes/{noteId}) ───
// 읽기는 모든 마스터 역할, 쓰기는 최고관리자·운영·CS, 삭제는 서버가 canDelete로 알려 준 것만(쓴 사람 본인·최고관리자). 파트너스에는 보이지 않는다.
type Note = { id: string; body: string; author: { id: string; name: string }; createdAt: string; canDelete: boolean };
type NotePage = { notes: Note[]; nextCursor: string | null };
type NoteLoad = { kind: "loading" } | { kind: "error" } | { kind: "ok"; notes: Note[]; next: string | null };
const NOTE_MAX = 1000;

export function PartnerNotes({ sellerId }: { sellerId: string }) {
  const { me } = useAdmin();
  const canWrite = adminCan(me.role, "seller.moderate") || adminCan(me.role, "support.manage");
  const [state, setState] = useState<NoteLoad>({ kind: "loading" });
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [removing, setRemoving] = useState<Note | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const reqId = useRef(0);
  const base = `/api/admin/sellers/${sellerId}/notes`;
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<NotePage>(base);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", notes: r.data.notes, next: r.data.nextCursor } : { kind: "error" });
  }, [base]);
  useEffect(() => void load(), [load]);

  const count = textLength(body);
  const invalid = count === 0 || count > NOTE_MAX;
  const add = async () => {
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    const r = await adminApi<{ note: Note }>(base, { method: "POST", json: { body: body.trim() } });
    setBusy(false);
    if (r.ok) {
      setBody("");
      setState((s) => (s.kind === "ok" ? { ...s, notes: [r.data.note, ...s.notes] } : s));
      return setToast({ text: "메모를 남겼습니다." });
    }
    setError(r.message ?? failMessage(r, "메모를 남기지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };
  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const r = await adminApi<NotePage>(`${base}?cursor=${encodeURIComponent(state.next)}`);
    setMore(false);
    if (r.ok) setState({ kind: "ok", notes: [...state.notes, ...r.data.notes], next: r.data.nextCursor });
    else setToast({ text: "더 불러오지 못했습니다. 다시 눌러 주십시오.", neg: true });
  };
  const remove = async () => {
    if (!removing || busy) return;
    setBusy(true);
    const r = await adminApi<{ ok: true }>(`${base}/${removing.id}`, { method: "DELETE" });
    setBusy(false);
    if (r.ok || r.status === 404) {
      const id = removing.id;
      setState((s) => (s.kind === "ok" ? { ...s, notes: s.notes.filter((n) => n.id !== id) } : s));
      setRemoving(null);
      return setToast({ text: "메모를 지웠습니다." });
    }
    setRemoving(null);
    setToast({ text: r.message ?? "지우지 못했습니다. 본인이 쓴 메모나 최고관리자만 지울 수 있습니다.", neg: true });
  };

  return (
    <section className="card pad-l col" style={{ gap: 14 }} aria-label="메모" data-testid="tab-notes">
      <p className="t-l2 c-alt" style={{ margin: 0 }}>
        관리자끼리 보는 메모입니다. 파트너스에게는 보이지 않습니다.
      </p>
      {canWrite && (
        <div className="col" style={{ gap: 6 }}>
          <textarea className="inp" rows={3} aria-label="메모 내용" value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} />
          <span className={`t-c1 ${count > NOTE_MAX ? "c-neg" : "c-alt"}`}>
            {count}/{NOTE_MAX}
          </span>
          {error && (
            <span className="err" role="alert">
              {error}
            </span>
          )}
          <div>
            <button className="btn" type="button" onClick={() => void add()} disabled={busy || invalid}>
              메모 남기기
            </button>
          </div>
        </div>
      )}
      {state.kind === "loading" && <LoadingRows rows={3} />}
      {state.kind === "error" && <ErrorState title="메모를 불러오지 못했습니다." onRetry={() => void load()} />}
      {state.kind === "ok" &&
        (state.notes.length === 0 ? (
          <div className="st">
            <span className="t">남긴 메모가 없습니다.</span>
          </div>
        ) : (
          <div className="col" style={{ gap: 12 }}>
            {state.notes.map((n) => (
              <div key={n.id} className="col" style={{ gap: 4 }} data-testid="note-item">
                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  <b>{n.author.name}</b>
                  <span className="t-l2 c-alt">{dayTime(n.createdAt)}</span>
                  {n.canDelete && (
                    <button className="btn btn-sm btn-out" type="button" onClick={() => setRemoving(n)}>
                      삭제
                    </button>
                  )}
                </div>
                <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{n.body}</p>
              </div>
            ))}
            {state.next && (
              <div className="row" style={{ justifyContent: "center" }}>
                <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                  {more ? "불러오는 중" : "더 보기"}
                </button>
              </div>
            )}
          </div>
        ))}
      {removing && (
        <Modal labelId="note-remove-title" busy={busy} onClose={() => setRemoving(null)}>
          {(requestClose) => (
            <>
              <div className="modal-h">
                <h2 className="modal-t" id="note-remove-title">
                  메모를 삭제하시겠습니까?
                </h2>
                <span className="t-l2 c-alt">지운 메모는 되돌릴 수 없습니다.</span>
              </div>
              <div className="modal-f">
                <button className="btn btn-out" type="button" onClick={requestClose} disabled={busy}>
                  취소
                </button>
                <button className="btn" type="button" onClick={() => void remove()} disabled={busy}>
                  {busy ? "처리 중" : "삭제"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </section>
  );
}

// ─── 결제 연결(GET /api/admin/pg-status?q=, 이 파트너스의 줄) ───
type PgRow = {
  seller: { id: string };
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  failures24h: number;
  cancelsPending: number;
  cancelsFailed: number;
};
type PgLoad = { kind: "loading" } | { kind: "error" } | { kind: "ok"; row: PgRow | null };

export function PartnerPg({ sellerId, slug }: { sellerId: string; slug: string }) {
  const [state, setState] = useState<PgLoad>({ kind: "loading" });
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<{ sellers: PgRow[] }>(`/api/admin/pg-status?q=${encodeURIComponent(slug)}&limit=200`);
    setState(r.ok ? { kind: "ok", row: r.data.sellers.find((x) => x.seller.id === sellerId) ?? null } : { kind: "error" });
  }, [sellerId, slug]);
  useEffect(() => void load(), [load]);
  return (
    <section className="card pad-l col" style={{ gap: 14 }} aria-label="결제 연결" data-testid="tab-pg">
      {state.kind === "loading" && <LoadingRows rows={3} />}
      {state.kind === "error" && <ErrorState title="결제 연결 상태를 불러오지 못했습니다." onRetry={() => void load()} />}
      {state.kind === "ok" &&
        (state.row ? (
          <dl className="kv">
            <dt>마지막으로 결제된 때</dt>
            <dd>{dayTime(state.row.lastSuccessAt)}</dd>
            <dt>마지막 실패</dt>
            <dd>{dayTime(state.row.lastFailureAt)}</dd>
            <dt>결제 실패 이유</dt>
            <dd>{state.row.lastFailureMessage ?? "-"}</dd>
            <dt>최근 24시간 결제 실패</dt>
            <dd data-testid="pg-failures">{state.row.failures24h.toLocaleString("ko-KR")}건</dd>
            <dt>결제 취소 대기</dt>
            <dd>{state.row.cancelsPending.toLocaleString("ko-KR")}건</dd>
            <dt>결제 취소 실패</dt>
            <dd>{state.row.cancelsFailed.toLocaleString("ko-KR")}건</dd>
          </dl>
        ) : (
          <div className="st">
            <span className="t">결제 내역이 없습니다.</span>
          </div>
        ))}
      <div className="row" style={{ gap: 8 }}>
        <Link className="btn btn-sm btn-out" href="/admin/settlement/pg">
          PG 연결 상태
        </Link>
        <Link className="btn btn-sm btn-out" href={`/admin/billing/invoices?sellerId=${sellerId}`}>
          청구·결제 내역
        </Link>
      </div>
    </section>
  );
}

// ─── 활동 기록(로그 추적, 파트너스 지정) ───
export function PartnerActivity({ sellerId }: { sellerId: string }) {
  return (
    <section className="card pad-l col" style={{ gap: 12 }} aria-label="활동 기록" data-testid="tab-activity">
      <p className="t-l2 c-alt" style={{ margin: 0 }}>
        이 파트너스에 대해 관리자가 한 일과 파트너스가 남긴 기록은 로그 추적에서 봅니다.
      </p>
      <div>
        <Link className="btn btn-out" href={`/admin/logs?sellerId=${sellerId}`}>
          이 파트너스의 로그 추적 보기
        </Link>
      </div>
    </section>
  );
}
