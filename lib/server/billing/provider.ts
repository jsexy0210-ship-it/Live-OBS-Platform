// 구독료 카드 자동결제(빌링키) 공급자 인터페이스. 업체(NICEPAY·페이플 등 후보)는 이 인터페이스로 바꿔 끼운다.
// 개발·테스트는 FakeBillingProvider만 쓴다(BILLING_PROVIDER=fake를 명시했을 때만). 실제 결제는 일어나지 않는다.

export type IssueResult = { ok: true; billingKey: string; cardLabel: string } | { ok: false; reason: "card_rejected" };
export type ChargeResult = { ok: true; paymentId: string; receiptUrl: string | null } | { ok: false; reason: string };
// 같은 청구 id로 PG에 남은 결과 조회(타임아웃 등으로 결과를 못 받았을 때 확정용)
export type PaymentLookup = { status: "PAID"; paymentId: string; receiptUrl: string | null } | { status: "FAILED"; reason: string } | { status: "NOT_FOUND" };

export type ChargeInput = { billingKey: string; customerKey: string; amount: number; orderId: string; orderName: string };

export interface BillingProvider {
  readonly name: string;
  // 카드 등록 창에서 받은 인증값으로 빌링키를 발급받는다.
  issueBillingKey(input: { authKey: string; customerKey: string }): Promise<IssueResult>;
  // 빌링키로 결제한다. orderId는 우리 청구 id다. 같은 orderId로 다시 요청해도 한 번만 결제되게 PG에 넘긴다.
  charge(input: ChargeInput): Promise<ChargeResult>;
  getPayment(orderId: string): Promise<PaymentLookup>;
}

export class FakeBillingProvider implements BillingProvider {
  readonly name = "fake";
  private seq = 0;
  private declined = new Set<string>();
  private results = new Map<string, PaymentLookup>();
  readonly charges: { orderId: string; amount: number; billingKey: string }[] = [];
  // 테스트용: 다음 결제 요청을 어떻게 망가뜨릴지(결제 전 타임아웃 / 결제 후 응답 유실)
  failNext: "timeout_before_charge" | "timeout_after_charge" | null = null;

  // 운영 환경에서는 만들 수 없다. 테스트 서버 모드(OBS_TEST_MODE=1, testMode.ts)만 예외로 허용한다.
  constructor(env: string | undefined = process.env.NODE_ENV, opts: { testMode?: boolean } = {}) {
    if (env === "production" && !opts.testMode) throw new Error("운영 환경에서는 가짜 결제 공급자를 쓸 수 없어요.");
  }

  async issueBillingKey({ authKey }: { authKey: string; customerKey: string }): Promise<IssueResult> {
    if (authKey.startsWith("reject")) return { ok: false, reason: "card_rejected" };
    return { ok: true, billingKey: `fake-bk-${authKey}-${++this.seq}`, cardLabel: "테스트카드 1234" };
  }

  // 테스트에서 이 빌링키의 결제를 거절하게 한다.
  decline(billingKey: string) {
    this.declined.add(billingKey);
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const mode = this.failNext;
    this.failNext = null;
    if (mode === "timeout_before_charge") throw new Error("PG 응답 시간 초과");
    const prev = this.results.get(input.orderId);
    let result: ChargeResult;
    if (prev?.status === "PAID") result = { ok: true, paymentId: prev.paymentId, receiptUrl: prev.receiptUrl };
    else if (this.declined.has(input.billingKey)) {
      this.results.set(input.orderId, { status: "FAILED", reason: "card_declined" });
      result = { ok: false, reason: "card_declined" };
    } else {
      this.charges.push({ orderId: input.orderId, amount: input.amount, billingKey: input.billingKey });
      this.results.set(input.orderId, { status: "PAID", paymentId: `fake-pay-${input.orderId}`, receiptUrl: null });
      result = { ok: true, paymentId: `fake-pay-${input.orderId}`, receiptUrl: null };
    }
    if (mode === "timeout_after_charge") throw new Error("PG 응답 시간 초과");
    return result;
  }

  async getPayment(orderId: string): Promise<PaymentLookup> {
    return this.results.get(orderId) ?? { status: "NOT_FOUND" };
  }
}
