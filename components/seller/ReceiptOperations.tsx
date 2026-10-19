"use client";

import Link from "next/link";
import { sanitizeNext } from "../../lib/client/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListTable, PageHead, useConfirm } from "../admin-ui";
import { Topbar, useSeller } from "./SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "./States";
import { api } from "./api";
import { won } from "./format";
import { formatDateTime } from "../../lib/client/format";
import { RECEIPT_BADGE as BADGE, RECEIPT_KIND as KIND, receiptNote, type ReceiptRow as Row } from "./orders";

type Result = { id: string; ok: boolean; reason?: string };
const COMPLETE_FAIL: Record<string, string> = { invalid_transition: "이미 처리된 신청입니다", not_paid: "입금 확인 전입니다", not_found: "신청을 찾을 수 없습니다" };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; rows: Row[]; missing: number };

export function ReceiptOperations({ ids, single = false, returnTo }: { ids: string[]; single?: boolean; returnTo?: string | null }) {
  const { can, me } = useSeller();
  const safeReturnTo = sanitizeNext(returnTo, ["/seller/orders/receipts"]);
  const listHref = safeReturnTo?.split("?")[0] === "/seller/orders/receipts" ? safeReturnTo : "/seller/orders/receipts";
  const canRead = can("RECEIPT_TAX"), canEdit = canRead && !me.readOnly;
  const { confirm } = useConfirm();
  const requestKey = ids.join(",");
  const requestIds = useMemo(() => [...new Set(requestKey.split(",").map((id) => id.toLowerCase()))], [requestKey]);
  const valid = requestIds.length > 0 && requestIds.length <= 50 && requestIds.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  const generation = useRef(0);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const load = useCallback(async () => {
    const request = ++generation.current;
    if (!canRead || !valid) return;
    setState({ kind: "loading" });
    const responses = await Promise.all(requestIds.map((id) => api<{ request: Row }>(`/api/seller/receipt-requests/${id}?summary=1`)));
    if (request !== generation.current) return;
    const failed = responses.find((r) => !r.ok && (single || r.status !== 404));
    if (failed && !failed.ok) return setState({ kind: "error", status: failed.status });
    setState({ kind: "ok", rows: responses.flatMap((r) => r.ok ? [r.data.request] : []), missing: responses.filter((r) => !r.ok && r.status === 404).length });
  }, [canRead, valid, requestIds, single]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const retry = async (r: Row) => {
    await confirm({
      title: "다시 발행하시겠습니까?",
      body: `${r.nickname ?? "탈퇴 회원"}님의 ${KIND[r.kind]} 신청을 발행 대기로 돌립니다. 발행 업체 연동이 되면 이어서 발행됩니다.`,
      confirmLabel: "다시 발행",
      run: async () => {
        const res = await api(`/api/seller/receipt-requests/${r.id}/retry`, { method: "POST" });
        if (!res.ok) return res.message ?? "다시 발행하지 못했습니다. 잠시 뒤 다시 시도해 주십시오";
        setToast({ text: "발행 대기로 돌렸습니다" });
        await load();
      },
    });
  };

  // 직접 발행한 건을 발행 완료로 바꾼다(구매자 안내가 간다). 한 건은 행에서, 여러 건은 선택해서 처리한다
  const complete = async (ids: string[], who: string) => {
    await confirm({
      title: ids.length === 1 ? "발행 완료 처리하시겠습니까?" : `${ids.length}건을 발행 완료 처리하시겠습니까?`,
      body: `${who}의 신청을 발행 완료로 바꿉니다. 구매자에게 알림이 갑니다. 홈택스 등에서 이미 발행한 건만 처리해 주십시오.`,
      confirmLabel: "발행 완료 처리",
      run: async () => {
        setBusy(true);
        const res = ids.length === 1 ? await api<{ ok?: boolean }>(`/api/seller/receipt-requests/${ids[0]}/complete`, { method: "POST" }) : await api<{ results: Result[]; completed: number }>("/api/seller/receipt-requests/complete", { method: "POST", body: { ids } });
        setBusy(false);
        if (!res.ok) return res.message ?? "발행 완료 처리하지 못했습니다. 잠시 뒤 다시 시도해 주십시오";
        const results = "results" in res.data ? res.data.results : [{ id: ids[0], ok: true }];
        const failed = results.filter((x) => !x.ok);
        setToast(failed.length > 0 ? { text: `${results.length - failed.length}건 처리, ${failed.length}건은 처리하지 못했습니다 · ${COMPLETE_FAIL[failed[0].reason ?? ""] ?? "잠시 뒤 다시 시도해 주십시오"}`, neg: results.length === failed.length } : { text: `${results.length}건을 발행 완료로 처리했습니다` });
        await load();
      },
    });
  };


  const rows = state.kind === "ok" ? state.rows : [];
  return <><Topbar crumb="주문 › 영수증 · 세금계산서 › 상세" /><main className="main">
    <PageHead title={single ? "영수증 · 세금계산서 상세" : "선택 발행 완료 처리"} back={listHref} />
    {!canRead ? <NoPermission need="영수증 · 세금계산서" /> : !valid ? <div className="card pad">작업할 신청을 목록에서 다시 선택해 주십시오.</div> : state.kind === "loading" ? <div className="card"><LoadingRows rows={3} /></div> : state.kind === "error" ? state.status === 403 ? <NoPermission need="영수증 · 세금계산서" /> : state.status === 402 ? <div className="card"><Locked /></div> : <div className="card"><ErrorState title="신청을 불러오지 못했습니다" onRetry={() => void load()} /></div> : <>
      <section className="au-list-section" aria-label="신청 상세">
        {state.missing > 0 && <p role="status">찾을 수 없는 신청 {state.missing}건 · 남은 신청 {rows.length}건</p>}
        <ListTable><table className="tbl"><thead><tr><th>주문</th><th>닉네임</th><th>접수 시각</th><th>종류 · 번호 끝</th><th>금액</th><th>상태</th><th>비고</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{single ? row.orderNoLabel : <Link href={`/seller/orders/receipts/${row.id}?${new URLSearchParams({ returnTo: listHref })}`}>{row.orderNoLabel}</Link>}</td><td>{row.nickname ?? "탈퇴 회원"}</td><td>{formatDateTime(row.createdAt)}</td><td>{KIND[row.kind]} · {row.identityLast4}{row.taxInfo && <div>{row.taxInfo.companyName}</div>}</td><td>{row.issue ? won(row.issue.amount) : "—"}</td><td>{row.issue ? <span className={`bdg ${BADGE[row.issue.status].cls}`}>{BADGE[row.issue.status].label}</span> : "—"}</td><td>{receiptNote(row)}</td></tr>)}</tbody></table></ListTable>
      </section>
      {canEdit && <section className="card pad" aria-label="발행 처리">
        <p>홈택스 등에서 이미 발행한 건만 처리해 주십시오. 발행 완료로 바꾸면 구매자에게 알림이 갑니다.</p>
        {single && rows[0]?.issue && ["FAILED", "ON_HOLD"].includes(rows[0].issue.status) ? <button className="btn" type="button" disabled={busy} onClick={() => void retry(rows[0])}>다시 발행</button> : <button className="btn" type="button" disabled={busy || !rows.some((row) => row.issue?.status === "PENDING")} onClick={() => void complete(rows.map((row) => row.id), single ? `${rows[0]?.nickname ?? "탈퇴 회원"}님의 ${rows[0] ? KIND[rows[0].kind] : ""}` : `선택한 ${rows.length}건`)}>발행 완료 처리</button>}
      </section>}
    </>}
  </main>{toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}</>;
}
