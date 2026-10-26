"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, PageHead } from "../admin-ui";
import { sanitizeNext, useSmartBack } from "../../lib/client/navigation";
import { formatDateTime } from "../../lib/client/format";
import { Topbar, useSeller } from "./SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "./States";
import { api, failMessage } from "./api";
import { HitCardModal } from "./broadcast/HitCardModal";
import { SourceBadge } from "./broadcast/SourceBadge";

type Card = { id: string; cardName: string; nickname: string; grade: string | null; note: string | null; createdAt: string; broadcast: { id: string; title: string | null } | null; order: { orderNo: string; productLabel: string } | null; source?: "INTERNAL" | "EXTERNAL" | null };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; card: Card };

export function HitCardOperations({ cardId, returnTo }: { cardId?: string; returnTo: string | null }) {
  const { can, me } = useSeller();
  const allowed = can("BROADCAST_RUN"), canEdit = allowed && !me.readOnly;
  const safeReturnTo = sanitizeNext(returnTo, ["/seller/hit-cards"]);
  const listHref = safeReturnTo?.split("?")[0] === "/seller/hit-cards" ? safeReturnTo : "/seller/hit-cards";
  const back = useSmartBack(listHref);
  const backHandler = useRef<(() => Promise<void>) | null>(null);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const generation = useRef(0);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const load = useCallback(async () => {
    const request = ++generation.current;
    if (!allowed || !cardId) return;
    setState({ kind: "loading" });
    const r = await api<{ card: Card }>(`/api/seller/hit-cards/${cardId}`);
    if (request !== generation.current) return;
    setState(r.ok && r.data.card.id.toLowerCase() === cardId.toLowerCase() ? { kind: "ok", card: r.data.card } : { kind: "error", status: r.ok ? 404 : r.status });
  }, [allowed, cardId]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const remove = async () => {
    if (!canEdit || state.kind !== "ok" || busy) return;
    setBusy(true);
    const r = await api<{ ok: true }>(`/api/seller/hit-cards/${state.card.id}`, { method: "DELETE" });
    setBusy(false);
    // 이미 지워진 카드도 기존 목록과 같이 완료로 처리한다.
    if (!r.ok && r.status !== 404) return setToast(failMessage(r, "admin"));
    setConfirm(false);
    setDone("HIT 카드를 지웠습니다");
  };
  return <><Topbar crumb="방송 › HIT 카드 기록 › 상세" /><main className="main">
    <PageHead title={cardId ? "HIT 카드 상세" : "HIT 카드 기록하기"} back={listHref} onBack={() => { if (backHandler.current) return backHandler.current(); if (!busy) back(); }} />
    {!allowed || (!cardId && !canEdit) ? <NoPermission need="방송 진행" /> : done ? <section className="card pad"><p role="status">{done}</p><button className="btn btn-out" type="button" onClick={back}>목록으로</button></section> : !cardId ? <section className="card pad"><HitCardModal fullPage targets={[]} backHandler={backHandler} onClose={back} onDone={() => setDone("HIT 카드를 기록했습니다")} /></section> : state.kind === "loading" ? <div className="card"><LoadingRows rows={4} /></div> : state.kind === "error" ? state.status === 403 ? <NoPermission need="방송 진행" /> : state.status === 402 ? <div className="card"><Locked /></div> : <div className="card"><ErrorState title={state.status === 404 ? "HIT 카드를 찾을 수 없습니다" : "HIT 카드 기록을 불러오지 못했습니다"} onRetry={() => void load()} /></div> : <section aria-label="HIT 카드 상세">
      <section className="card pad"><h2 className="t-h2">{state.card.cardName}</h2><dl><dt>구매자</dt><dd>{state.card.nickname}</dd><dt>일시</dt><dd>{formatDateTime(state.card.createdAt)}</dd><dt>등급</dt><dd>{state.card.grade ?? "-"}</dd><dt>메모 (나만 보임)</dt><dd>{state.card.note ?? "-"}</dd><dt>주문</dt><dd>{state.card.order ? `${state.card.order.orderNo} · ${state.card.order.productLabel}` : state.card.source === "EXTERNAL" ? <SourceBadge source="EXTERNAL" /> : "-"}</dd><dt>방송</dt><dd>{state.card.broadcast ? state.card.broadcast.title || "제목 없는 방송" : "-"}</dd></dl>
        {canEdit && <button className="btn btn-neg" type="button" onClick={() => setConfirm(true)}>카드 지우기</button>}
      </section>
    </section>}
  </main>
    {canEdit && state.kind === "ok" && confirm && !done && <Modal labelId="hit-del-title" busy={busy} onClose={() => setConfirm(false)}><div className="modal-h"><h2 className="modal-t" id="hit-del-title">이 HIT 카드를 지우시겠습니까?</h2><span className="t-l2 c-alt">{state.card.nickname} · {state.card.cardName}</span></div><span className="t-l2">방송 화면에서도 바로 사라집니다. 지운 카드는 되살릴 수 없습니다.</span><div className="modal-f"><button className="btn btn-out" type="button" disabled={busy} onClick={() => setConfirm(false)}>취소</button><button className="btn btn-neg" type="button" disabled={busy} onClick={() => void remove()}>카드 지우기</button></div></Modal>}
    {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
  </>;
}
