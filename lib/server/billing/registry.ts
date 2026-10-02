import { FakeBillingProvider, type BillingProvider } from "./provider";

// 라우트가 쓰는 결제 공급자. BILLING_PROVIDER 환경변수로 고른다. 실제 업체 연동 전이라 지금은 fake만 있고,
// fake는 명시했을 때만 쓴다(NODE_ENV에 기대지 않음). 설정이 없으면 결제 경로는 오류로 멈춘다.
const globalForBilling = globalThis as unknown as { billingProvider?: BillingProvider };

export function billingProvider(): BillingProvider {
  const name = process.env.BILLING_PROVIDER;
  if (name !== "fake") throw new Error("결제 공급자(BILLING_PROVIDER)가 설정되지 않았어요.");
  globalForBilling.billingProvider ??= new FakeBillingProvider();
  return globalForBilling.billingProvider;
}
