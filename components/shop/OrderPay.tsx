"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useConfirm } from "../admin-ui/ConfirmDialog";
import { formatDateTime } from "../../lib/client/format";
import { call } from "./reviewShared";

// SH-007 결제(주문 상세의 결제 대기 주문): 결제 수단(카드·무통장 입금) → 「n원 결제하기」.
// 카드는 서버가 준 값으로 나이스페이 결제 창(테스트 결제)을 열고, 끝나면 서버가 승인까지 마친 뒤 주문 화면으로 돌려보낸다.
// 무통장 입금은 입금 계좌·기한을 안내한다(입금 확인은 판매자). 결제 금액은 서버가 계산한 주문 금액이며 바꿀 수 없다.
type CardStart = { clientId: string; method: string; orderId: string; amount: number; goodsName: string; returnUrl: string; paymentDueAt?: string | null };
type Bank = { amount: number; bankName: string; accountNumber: string; accountHolder: string; paymentDueAt: string | null };
type Nice = { requestPay: (o: Record<string, unknown>) => void };
declare global {
  interface Window {
    AUTHNICE?: Nice;
  }
}

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

function loadSdk(): Promise<Nice> {
  if (window.AUTHNICE) return Promise.resolve(window.AUTHNICE);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://pay.nicepay.co.kr/v1/js/";
    s.onload = () => (window.AUTHNICE ? resolve(window.AUTHNICE) : reject(new Error("sdk")));
    s.onerror = () => reject(new Error("sdk"));
    document.head.appendChild(s);
  });
}

export default function OrderPay({ slug, orderId, amount, dueAt }: { slug: string; orderId: string; amount: number; dueAt: string | null }) {
  const { confirm } = useConfirm();
  const api = `/api/shop/${encodeURIComponent(slug)}/payments`;
  // 주문서에서 고른 결제 수단(?pay=card|bank)을 미리 골라 둔다
  const [method, setMethod] = useState<"card" | "bank">(useSearchParams().get("pay") === "bank" ? "bank" : "card");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bank, setBank] = useState<Bank | null>(null);
  const [due, setDue] = useState(dueAt);

  // 결제 시작·무통장 입금 선택은 되돌리기 어려워 확인 창을 거친다(이미 받은 입금 안내를 다시 보는 것은 바로)
  async function askPay() {
    if (busy) return;
    if (method === "bank" && bank) return void pay();
    const ok = await confirm(
      method === "bank"
        ? { tone: "shop", title: "무통장 입금으로 할까요?", body: "입금 계좌가 나와요. 기한 안에 입금하지 않으면 주문이 자동으로 취소돼요.", confirmLabel: "입금 안내 받기" }
        : { tone: "shop", title: `${won(amount)}을 결제할까요?`, body: "카드 결제 창이 열려요. 결제하면 주문이 접수돼요.", confirmLabel: "결제하기" },
    );
    if (ok) void pay();
  }

  async function pay() {
    if (busy) return;
    setBusy(true);
    setError(null);
    if (method === "bank") {
      const r = await call<Bank>(`${api}/bank-transfer`, { method: "POST", body: { orderId } });
      if (r.ok) {
        setBank(r.data);
        if (r.data.paymentDueAt) setDue(r.data.paymentDueAt);
      } else setError(r.message ?? "무통장 입금 안내를 불러오지 못했어요. 잠시 뒤 다시 해 주세요");
      return setBusy(false);
    }
    const r = await call<CardStart>(api, { method: "POST", body: { orderId } });
    if (!r.ok) {
      setError(r.message ?? "결제를 시작하지 못했어요. 잠시 뒤 다시 해 주세요");
      return setBusy(false);
    }
    if (r.data.paymentDueAt) setDue(r.data.paymentDueAt);
    try {
      const nice = await loadSdk();
      const { clientId, method: m, orderId: attempt, amount: sum, goodsName, returnUrl } = r.data;
      nice.requestPay({
        clientId,
        method: m,
        orderId: attempt,
        amount: sum,
        goodsName,
        returnUrl,
        fnError: (e: { errorMsg?: string } | undefined) => {
          setError(e?.errorMsg ? `결제 창을 열지 못했어요. 잠시 뒤 다시 눌러 주세요. 계속 안 되면 판매자에게 문의해 주세요` : "결제 창을 열지 못했어요. 잠시 뒤 다시 눌러 주세요. 계속 안 되면 판매자에게 문의해 주세요");
          setBusy(false);
        },
      });
      // 결제 창이 열려 있는 동안은 다시 누르지 못하게 둔다. 창이 끝나면 서버가 주문 화면으로 돌려보낸다
      window.setTimeout(() => setBusy(false), 5000);
    } catch {
      setError("결제 창을 불러오지 못했어요. 잠시 뒤 다시 해 주세요");
      setBusy(false);
    }
  }

  return (
    <section className="co-box" aria-labelledby="od-pay">
      <h2 id="od-pay">결제</h2>
      <div className="co-radios" role="radiogroup" aria-label="결제 수단">
        <label className="co-radio">
          <input type="radio" name="pay-method" checked={method === "card"} onChange={() => setMethod("card")} />
          <span>
            <b>카드 결제</b>
          </span>
        </label>
        <label className="co-radio">
          <input type="radio" name="pay-method" checked={method === "bank"} onChange={() => setMethod("bank")} />
          <span>
            <b>무통장 입금</b>
          </span>
        </label>
      </div>
      {due && <p className="cart-hint">결제 기한 {formatDateTime(due)}까지예요. 기한이 지나면 주문이 자동으로 취소돼요.</p>}
      {bank && (
        <dl className="od-dl" aria-label="입금 계좌 안내">
          <div>
            <dt>입금 은행</dt>
            <dd>{bank.bankName}</dd>
          </div>
          <div>
            <dt>계좌번호</dt>
            <dd>{bank.accountNumber}</dd>
          </div>
          <div>
            <dt>예금주</dt>
            <dd>{bank.accountHolder}</dd>
          </div>
          <div>
            <dt>입금 금액</dt>
            <dd>{won(bank.amount)}</dd>
          </div>
        </dl>
      )}
      {error && (
        <p className="cart-msg is-err" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-lg btn-block" type="button" disabled={busy} aria-busy={busy} onClick={() => void askPay()}>
        {method === "bank" ? (bank ? "입금 안내 다시 보기" : "무통장 입금 안내 받기") : `${won(amount)} 결제하기`}
      </button>
      {method === "bank" && <p className="cart-hint">입금하면 판매자가 확인한 뒤 주문 상태가 결제 완료로 바뀌어요.</p>}
    </section>
  );
}
