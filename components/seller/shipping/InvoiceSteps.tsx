import "../../../styles/seller-invoices.css";

const STEPS = ["주문 선택", "합배송 · 주소 확인", "송장 발급", "출력", "추적"];

// 송장 발급 5단계 띠(SA-027·028). now는 지금 단계(1부터), 앞 단계는 ✓로 표시한다
export function InvoiceSteps({ now }: { now: number }) {
  return (
    <ol className="inv-steps" aria-label="송장 발급 단계">
      {STEPS.map((s, i) => (
        <li key={s} className={i + 1 < now ? "done" : i + 1 === now ? "now" : undefined} aria-current={i + 1 === now ? "step" : undefined}>
          {i + 1 < now ? `✓ ${s}` : `${i + 1}. ${s}`}
        </li>
      ))}
    </ol>
  );
}
