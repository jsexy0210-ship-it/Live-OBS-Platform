"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../../components/seller/States";
import { adminApi } from "../../../../_components/api";
import { AdminTopbar } from "../../../../_components/AdminShell";
import { SUBSCRIPTION_STATUS, day, dayTime, won, type SubscriptionStatus } from "../../../../_components/partners";
import { PAYMENT_KIND, PAYMENT_STATUS, planLabel, safeUrl, type PaymentDetail } from "../../../../_components/payments";

// MA-025 청구 상세(GET /api/admin/payments/{id}, 모든 마스터 역할, 조회만): 청구·결제사 결제 번호·카드 매출전표·구독.
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; payment: PaymentDetail };

function Info({ title, id, rows }: { title: string; id: string; rows: [string, React.ReactNode][] }) {
  return (
    <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby={id}>
      <h2 className="t-hl1" id={id}>
        {title}
      </h2>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default function InvoiceDetailPage() {
  const { paymentId } = useParams<{ paymentId: string }>();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<{ payment: PaymentDetail }>(`/api/admin/payments/${encodeURIComponent(paymentId)}`);
    setState(r.ok ? { kind: "ok", payment: r.data.payment } : { kind: "error", status: r.status });
  }, [paymentId]);
  useEffect(() => void load(), [load]);

  const p = state.kind === "ok" ? state.payment : null;
  const receipt = safeUrl(p?.receiptUrl ?? null);

  return (
    <>
      <AdminTopbar crumb="구독·요금 › 청구·결제 내역 › 청구 상세" />
      <main className="main">
        <PageHead
          title={p ? `${won(p.amount)} · ${PAYMENT_STATUS[p.status].label}` : "청구 상세"}
          actions={
            <Link className="btn btn-out" href="/admin/billing/invoices">
              청구·결제 내역
            </Link>
          }
        />
        {!p ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" &&
              (state.status === 404 ? (
                <div className="st">
                  <span className="t">청구 내역을 찾을 수 없습니다.</span>
                </div>
              ) : (
                <ErrorState title="청구 내역을 불러오지 못했습니다." onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            <Info
              title="청구 정보"
              id="invoice-basic"
              rows={[
                ["쇼핑몰", <Link key="s" href={`/admin/partners/${p.seller.id}`}>{p.seller.shopName}</Link>],
                ["금액", won(p.amount)],
                ["결제 상태", <span key="st" className={`bdg ${PAYMENT_STATUS[p.status].cls}`}>{PAYMENT_STATUS[p.status].label}</span>],
                ...(p.status === "FAILED" ? ([["실패 사유", p.failureReason ?? "-"]] as [string, React.ReactNode][]) : []),
                ["구분", PAYMENT_KIND[p.kind]],
                ...(p.kind === "PRORATION" ? ([["변경할 요금제", planLabel(p.targetPlanCode)]] as [string, React.ReactNode][]) : []),
                ["이용 기간", `${day(p.periodStart)} ~ ${day(p.periodEnd)}`],
                ["청구일", dayTime(p.createdAt)],
                ["결제일", dayTime(p.paidAt)],
                ["청구 방식", p.scheduled ? "자동 청구" : "직접 결제"],
                ["런칭 할인", p.launchDiscount ? "적용" : "미적용"],
              ]}
            />
            <Info
              title="결제 정보"
              id="invoice-provider"
              rows={[
                ["결제 번호", p.providerPaymentId ?? "-"],
                [
                  "카드 매출전표",
                  receipt ? (
                    <a key="r" href={receipt} target="_blank" rel="noopener noreferrer">
                      매출전표 보기
                    </a>
                  ) : (
                    "-"
                  ),
                ],
              ]}
            />
            <Info
              title="구독"
              id="invoice-subscription"
              rows={[
                ["구독 상태", <span key="sub" className={`bdg ${SUBSCRIPTION_STATUS[p.subscription.status as SubscriptionStatus]?.cls ?? "b-gray"}`}>{SUBSCRIPTION_STATUS[p.subscription.status as SubscriptionStatus]?.label ?? "-"}</span>],
                ["요금제", p.subscription.plan.name],
                ["결제 카드", p.subscription.cardLabel ?? "-"],
              ]}
            />
          </div>
        )}
      </main>
    </>
  );
}
