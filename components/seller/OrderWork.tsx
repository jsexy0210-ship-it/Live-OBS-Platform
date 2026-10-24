"use client";

import { useCallback, useEffect, useState } from "react";
import { confirmLeave, useUnsavedGuard } from "../../lib/client/navigation";
import { useSeller } from "./SellerShell";
import { api } from "./api";
import { textLength } from "./format";

// 주문 목록에서 이동한 실제 상세 업무. 서버의 주문별 처리·메모 검증은 그대로 사용한다.
export function PrepareShipping({ ids, disabled = false, onDone }: { ids: string[]; disabled?: boolean; onDone: () => void }) {
  const { can, me } = useSeller();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; failed: boolean } | null>(null);
  if (!can("ORDER_SHIPPING") || me.readOnly) return null;
  const prepare = async () => {
    if (busy || disabled || ids.length === 0) return;
    setBusy(true);
    const r = await api<{ results: { orderId: string; ok: boolean; reason?: string }[]; prepared: number }>("/api/seller/orders/bulk", { method: "POST", body: { action: "prepare_shipping", orderIds: ids } });
    setBusy(false);
    if (!r.ok) return setResult({ text: "배송 준비로 바꾸지 못했습니다. 다시 시도해 주십시오", failed: true });
    const failed = r.data.results.filter((x) => !x.ok).length;
    setResult({ text: failed === 0 ? `${r.data.prepared}건을 배송 준비로 바꿨습니다` : `${r.data.prepared}건을 바꿨고 ${failed}건은 바꾸지 못했습니다`, failed: failed > 0 });
    onDone();
  };
  return <div className="col" style={{ gap: 8 }}>
    <button className="btn" type="button" disabled={disabled || busy || !ids.length} onClick={() => void prepare()}>배송 준비로 변경</button>
    {result && <p role={result.failed ? "alert" : "status"} className={result.failed ? "c-neg" : undefined}>{result.text}</p>}
  </div>;
}

export function OrderMemo({ orderId, orderNoLabel, backHandler }: { orderId: string; orderNoLabel: string; backHandler?: { current: (() => Promise<boolean>) | null } }) {
  const { can, me } = useSeller();
  const allowed = can("ORDER_SHIPPING") && !me.readOnly;
  const [memo, setMemo] = useState({ text: "", saved: "", loaded: false, loading: true, saving: false, error: "", result: "" });
  const dirty = memo.loaded && memo.text !== memo.saved;
  const releaseGuard = useUnsavedGuard(dirty);
  useEffect(() => {
    if (!backHandler) return;
    const leave = async () => { if (memo.saving || !confirmLeave(dirty)) return false; await releaseGuard(); return true; };
    backHandler.current = leave;
    return () => { if (backHandler.current === leave) backHandler.current = null; };
  }, [backHandler, memo.saving, dirty, releaseGuard]);
  const load = useCallback(async () => {
    if (!allowed) return;
    setMemo((m) => ({ ...m, loading: true, error: "" }));
    const r = await api<{ memo: { body: string } | null }>(`/api/seller/orders/${orderId}/memo`);
    setMemo((m) => r.ok ? { ...m, text: r.data.memo?.body ?? "", saved: r.data.memo?.body ?? "", loaded: true, loading: false } : { ...m, loading: false, error: "메모를 불러오지 못했습니다. 다시 시도해 주십시오" });
  }, [orderId, allowed]);
  useEffect(() => { void load(); }, [load]);
  if (!allowed) return null;
  const save = async () => {
    if (!memo.loaded || memo.saving || memo.text === memo.saved) return;
    setMemo({ ...memo, saving: true, error: "", result: "" });
    const r = await api<{ memo: unknown }>(`/api/seller/orders/${orderId}/memo`, { method: "PUT", body: { body: memo.text } });
    if (!r.ok) {
      const error = r.error === "memo_member_withdrawn" ? "탈퇴한 회원의 주문에는 메모를 새로 남길 수 없습니다" : "메모를 저장하지 못했습니다. 다시 시도해 주십시오";
      return setMemo((m) => ({ ...m, saving: false, error }));
    }
    await releaseGuard();
    setMemo((m) => ({ ...m, saved: memo.text, saving: false, result: memo.text.trim() ? "메모를 저장했습니다" : "메모를 지웠습니다" }));
  };
  return <section className="card pad col" style={{ gap: 8 }} id="order-memo" aria-label="메모 남기기">
    <h2 className="t-hl2">메모 남기기</h2>
    <p className="help">{orderNoLabel} · 구매자에게는 보이지 않는 내부 메모입니다.</p>
    <textarea className="inp" rows={5} aria-label="메모" placeholder="메모 입력" disabled={!memo.loaded || memo.saving} value={memo.text} onChange={(e) => textLength(e.target.value) <= 1000 && setMemo({ ...memo, text: e.target.value, result: "" })} />
    <span className="help">{textLength(memo.text)}/1,000자</span>
    {memo.error && <p className="c-neg" role="alert">{memo.error}</p>}
    {!memo.loaded && !memo.loading && <button className="btn btn-out" type="button" onClick={() => void load()}>다시 시도</button>}
    {memo.result && <p role="status">{memo.result}</p>}
    <div className="row" style={{ gap: 8 }}>
      <button className="btn btn-out" type="button" disabled={memo.saving || !memo.loaded || memo.text === memo.saved} onClick={async () => { if (!confirmLeave(memo.text !== memo.saved)) return; setMemo((m) => ({ ...m, saving: true })); await releaseGuard(); setMemo((m) => ({ ...m, text: m.saved, saving: false, error: "", result: "" })); }}>취소</button>
      <button className="btn btn-pri" type="button" disabled={!memo.loaded || memo.saving || memo.text === memo.saved} onClick={() => void save()}>저장</button>
    </div>
  </section>;
}
