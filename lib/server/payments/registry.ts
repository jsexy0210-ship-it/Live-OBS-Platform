import type { PaymentGateway } from "./gateway";
import { NicepaySandboxGateway } from "./nicepay";

// 라우트가 쓰는 주문 결제 PG. 나이스페이 키(NICEPAY_CLIENT_KEY·NICEPAY_SECRET_KEY)가 둘 다 있을 때만 샌드박스 어댑터를 만든다.
// 키가 없으면 null → 결제 시작은 「결제 준비 중」으로 거절한다(돈이 움직이는 경로를 열지 않음).
const g = globalThis as unknown as { paymentGateway?: PaymentGateway | null; paymentGatewayOverride?: PaymentGateway | null };

export function paymentGateway(env: NodeJS.ProcessEnv = process.env): PaymentGateway | null {
  if (g.paymentGatewayOverride !== undefined) return g.paymentGatewayOverride;
  const clientKey = env.NICEPAY_CLIENT_KEY?.trim();
  const secretKey = env.NICEPAY_SECRET_KEY?.trim();
  if (!clientKey || !secretKey) return null;
  g.paymentGateway ??= new NicepaySandboxGateway(clientKey, secretKey);
  return g.paymentGateway;
}

// 시험용: 라우트가 쓸 PG를 바꾼다(undefined면 원래대로).
export function setPaymentGatewayForTest(gw: PaymentGateway | null | undefined) {
  g.paymentGatewayOverride = gw;
}
