import { AuthError } from "../authz/errors";
import { isTestMode, warnTestModeOnce } from "../testMode";
import { FakeBillingProvider, type BillingProvider } from "./provider";

// 라우트가 쓰는 결제 공급자. BILLING_PROVIDER 환경변수로 고른다. 실제 업체 연동 전이라 지금은 fake만 있고,
// fake는 명시했을 때만 쓴다(NODE_ENV에 기대지 않음). 설정이 없으면 결제 경로는 멈춘다: 라우트에는 500이 아니라 503 payment_not_ready(결제 준비 중)로 나간다(돈이 움직이지 않음).
const globalForBilling = globalThis as unknown as { billingProvider?: BillingProvider };

// 테스트 서버(OBS_TEST_MODE=1, testMode.ts)는 운영 빌드여도 가짜 결제 공급자를 쓴다(실제 결제 없음, 결제 기록 공급자 fake).
export function billingProvider(env: NodeJS.ProcessEnv = process.env): BillingProvider {
  if (isTestMode(env)) {
    warnTestModeOnce();
    globalForBilling.billingProvider ??= new FakeBillingProvider(env.NODE_ENV, { testMode: true });
    return globalForBilling.billingProvider;
  }
  const name = env.BILLING_PROVIDER;
  if (name !== "fake") throw new AuthError(503, "payment_not_ready");
  globalForBilling.billingProvider ??= new FakeBillingProvider();
  return globalForBilling.billingProvider;
}
