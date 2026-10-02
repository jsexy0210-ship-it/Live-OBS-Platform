import { FakeBillingProvider, type BillingProvider } from "./provider";

// 라우트가 쓰는 결제 공급자. 실제 PG 연동 전이라 운영에서는 쓸 수 있는 공급자가 없다(호출하면 오류).
const globalForBilling = globalThis as unknown as { billingProvider?: BillingProvider };

export function billingProvider(): BillingProvider {
  if (process.env.NODE_ENV === "production") {
    throw new Error("운영 결제 공급자가 아직 연결되지 않았어요.");
  }
  globalForBilling.billingProvider ??= new FakeBillingProvider();
  return globalForBilling.billingProvider;
}
