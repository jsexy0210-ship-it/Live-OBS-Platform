// 구독료 카드 자동결제(빌링키) 공급자 인터페이스. 실제 PG 연동은 계약·키 발급 후 이 인터페이스로 붙인다.
// 개발·테스트는 FakeBillingProvider만 쓴다. 실제 결제는 일어나지 않는다.

export type IssueResult = { ok: true; billingKey: string; cardLabel: string } | { ok: false; reason: "card_rejected" };
export type ChargeResult = { ok: true; paymentId: string; receiptUrl: string | null } | { ok: false; reason: string };

export interface BillingProvider {
  readonly name: string;
  // 카드 등록 창에서 받은 인증값으로 빌링키를 발급받는다.
  issueBillingKey(input: { authKey: string; customerKey: string }): Promise<IssueResult>;
  // 빌링키로 결제한다. orderId는 우리 청구 id라 같은 값으로 다시 요청해도 한 번만 결제되게 PG에 넘긴다.
  charge(input: { billingKey: string; customerKey: string; amount: number; orderId: string; orderName: string }): Promise<ChargeResult>;
}

export class FakeBillingProvider implements BillingProvider {
  readonly name = "fake";
  private seq = 0;
  private declined = new Set<string>();
  readonly charges: { orderId: string; amount: number; billingKey: string }[] = [];

  // 운영 환경에서는 만들 수 없다.
  constructor(env: string | undefined = process.env.NODE_ENV) {
    if (env === "production") throw new Error("운영 환경에서는 가짜 결제 공급자를 쓸 수 없어요.");
  }

  async issueBillingKey({ authKey }: { authKey: string; customerKey: string }): Promise<IssueResult> {
    if (authKey.startsWith("reject")) return { ok: false, reason: "card_rejected" };
    return { ok: true, billingKey: `fake-bk-${authKey}-${++this.seq}`, cardLabel: "테스트카드 1234" };
  }

  // 테스트에서 이 빌링키의 결제를 거절하게 한다.
  decline(billingKey: string) {
    this.declined.add(billingKey);
  }

  async charge(input: { billingKey: string; amount: number; orderId: string }): Promise<ChargeResult> {
    if (this.declined.has(input.billingKey)) return { ok: false, reason: "card_declined" };
    const prev = this.charges.find((c) => c.orderId === input.orderId);
    if (!prev) this.charges.push({ orderId: input.orderId, amount: input.amount, billingKey: input.billingKey });
    return { ok: true, paymentId: `fake-pay-${input.orderId}`, receiptUrl: null };
  }
}
