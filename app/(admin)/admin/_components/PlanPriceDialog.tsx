"use client";

import { useState } from "react";
import { Modal } from "../../../../components/admin-ui/Modal";
import { adminApi } from "./api";
import { PRICE_MAX, type AdminPlan } from "./messageFees";
import { won } from "./partners";

// 요금제 가격 변경(MA-022, 최고관리자만). 돈과 관련되고 되돌리기 어려워 바꾸기 전·후 금액을 함께 보여 주고 한 번 더 확인한다.
// 새 가입자는 바로, 기존 구독자는 필수 고지 완료 + 30일 뒤 첫 결제부터 적용된다(서버 규칙).
const ERROR: Record<string, string> = {
  invalid_price: `정가는 판매가 이상, 두 금액 모두 1원 이상 ${PRICE_MAX.toLocaleString("ko-KR")}원 이하의 정수여야 합니다.`,
  not_found: "요금제를 찾을 수 없습니다. 목록을 새로 불러와 주십시오.",
};

const toNum = (v: string) => (v.trim() === "" ? NaN : Number(v));

export function PlanPriceDialog({ plan, onClose, onDone }: { plan: AdminPlan; onClose: () => void; onDone: () => void }) {
  const [list, setList] = useState(String(plan.listPrice));
  const [sale, setSale] = useState(String(plan.salePrice));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const l = toNum(list);
  const s = toNum(sale);
  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= PRICE_MAX;
  const valid = inRange(l) && inRange(s) && l >= s;
  const changed = l !== plan.listPrice || s !== plan.salePrice;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || !changed || busy) return;
    if (!confirming) return setConfirming(true);
    setBusy(true);
    setError(null);
    const r = await adminApi(`/api/admin/plans/${plan.code}/price`, { method: "POST", json: { listPrice: l, salePrice: s } });
    setBusy(false);
    if (r.ok) return onDone();
    setConfirming(false);
    setError(ERROR[r.error] ?? (r.status === 403 ? "최고관리자만 바꿀 수 있습니다." : r.status === 0 ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오." : "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };

  return (
    <Modal labelId="plan-price-title" busy={busy} dirty={changed} onClose={onClose}>
      {(requestClose) => (
        <form className="col" style={{ gap: 16 }} onSubmit={submit} noValidate>
          <div className="modal-h">
            <h2 className="modal-t" id="plan-price-title">
              {plan.name} 가격 변경
            </h2>
          </div>
          <div className="col" style={{ gap: 16 }}>
            <div className="fld">
              <label htmlFor="plan-list">정가</label>
              <div className="row" style={{ gap: 8 }}>
                <input id="plan-list" className="inp" type="text" inputMode="numeric" value={list} onChange={(e) => { setList(e.target.value); setConfirming(false); }} disabled={busy} />
                <span>원</span>
              </div>
            </div>
            <div className="fld">
              <label htmlFor="plan-sale">판매가</label>
              <div className="row" style={{ gap: 8 }}>
                <input id="plan-sale" className="inp" type="text" inputMode="numeric" value={sale} onChange={(e) => { setSale(e.target.value); setConfirming(false); }} disabled={busy} />
                <span>원</span>
              </div>
              <span className="t-c1 c-alt">부가세 포함 금액입니다. 청구액은 판매가입니다.</span>
            </div>
            {!valid && <span className="t-c1 c-neg">{ERROR.invalid_price}</span>}
            {valid && changed && (
              <dl className="kv" data-testid="price-diff">
                <dt>정가</dt>
                <dd>
                  {won(plan.listPrice)} → {won(l)}
                </dd>
                <dt>판매가</dt>
                <dd>
                  {won(plan.salePrice)} → {won(s)}
                </dd>
              </dl>
            )}
            <span className="t-c1 c-alt">새 가입자는 바로 적용됩니다. 기존 구독자는 메일·알림톡·파트너스 공지 완료 30일 뒤 첫 결제부터 적용되며, 고지 전에는 기존 요금을 유지합니다.</span>
            {confirming && (
              <span className="err" role="alert">
                {plan.name}의 가격을 위 금액으로 바꾸시겠습니까?
              </span>
            )}
            {error && (
              <span className="err" role="alert">
                {error}
              </span>
            )}
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={requestClose} disabled={busy}>
              취소
            </button>
            <button className="btn" type="submit" disabled={!valid || !changed || busy}>
              {busy ? "저장 중" : confirming ? "가격 변경 확정" : "저장"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
