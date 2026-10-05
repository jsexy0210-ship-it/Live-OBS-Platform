// 구매자 주문 결제 PG 포트. 업체 어댑터(nicepay.ts)와 시험용 가짜(FakePaymentGateway)가 이 인터페이스를 따른다.
// 외부 호출은 모두 타임아웃(AbortSignal)을 건다. 결과는 셋으로 나눈다:
// - ok: PG가 성공을 확인해 줌(응답 서명·금액 검증까지 통과)
// - rejected: PG가 분명히 거절함(카드 거절·잔액 부족 등) → 돈이 움직이지 않음
// - unknown: 타임아웃·연결 끊김·형식이 틀린 응답 → 돈이 움직였는지 모름. 조회(getPayment)로 확정한다.

export type PgStatus = "paid" | "ready" | "failed" | "cancelled" | "partialCancelled" | "expired";

// card: 승인 응답의 카드 요약(카드사 이름·끝 4자리·할부 개월, 0 = 일시불). 카드번호 전체는 다루지 않는다.
export type PgCard = { name: string | null; last4: string | null; installment: number | null };
export type PgPayment = { tid: string; orderId: string; status: PgStatus; amount: number; balanceAmt: number; card?: PgCard };

export type PgResult<T> = { kind: "ok"; value: T } | { kind: "rejected"; code: string; message?: string } | { kind: "unknown"; error: string };

export type CancelInput = { tid: string; cancelOrderId: string; amount: number; partial: boolean; reason: string };
export type CancelValue = { cancelledTid: string | null; status: PgStatus; balanceAmt: number };

// 결제 창 인증 결과(returnUrl로 받은 값)
// authResultMsg: 인증 실패 사유 문구(실패 진단용 기록, 판단에는 쓰지 않음)
export type AuthResult = { authResultCode: string; authResultMsg?: string; tid: string; clientId: string; orderId: string; amount: string; authToken: string; signature: string };

export interface PaymentGateway {
  readonly name: string;
  // 결제 창(브라우저 SDK)에 넘기는 공개 식별값. 비밀키가 아니다.
  readonly clientId: string;
  // 인증 결과 서명 확인(위·변조 방지). 금액·주문번호 대조는 서비스가 한다.
  verifyAuthResult(r: AuthResult): boolean;
  approve(input: { tid: string; amount: number }): Promise<PgResult<PgPayment>>;
  cancel(input: CancelInput): Promise<PgResult<CancelValue>>;
  getPayment(tid: string): Promise<PgResult<PgPayment>>;
  // 승인 응답을 못 받았을 때(타임아웃) 결제를 거두는 망 취소
  netCancel(orderId: string): Promise<PgResult<null>>;
  // 웹훅 본문 서명 확인. 통과해도 본문 값을 그대로 믿지 않고 getPayment로 다시 확인한다.
  // status: 웹훅 종류(서명이 맞은 본문의 status, 기록용). 결제 판단에는 쓰지 않는다.
  verifyWebhook(body: unknown): { tid: string; status?: string } | null;
}

// 시험용 가짜 PG. 메모리에만 있고 돈은 움직이지 않는다. failNext로 타임아웃·거절을 흉내 낸다.
export class FakePaymentGateway implements PaymentGateway {
  readonly name = "fake";
  readonly clientId = "fake-client";
  readonly payments = new Map<string, PgPayment>();
  readonly cancelOrderIds = new Set<string>();
  approveCalls = 0;
  cancelCalls = 0;
  failNext: "reject" | "timeout_before" | "timeout_after" | null = null;
  // 인증만 끝난(승인 전) 거래: tid → { orderId, amount }
  private authed = new Map<string, { orderId: string; amount: number }>();

  constructor(env: string | undefined = process.env.NODE_ENV) {
    if (env === "production") throw new Error("운영 환경에서는 가짜 결제 공급자를 쓸 수 없어요.");
  }

  static sign(r: Omit<AuthResult, "signature">) {
    return `fake-sig:${r.authToken}:${r.clientId}:${r.amount}`;
  }

  // 결제 창 인증을 흉내 내 returnUrl로 오는 값을 만든다.
  authorize(orderId: string, amount: number, tid = `fake-tid-${orderId}`): AuthResult {
    this.authed.set(tid, { orderId, amount });
    const r = { authResultCode: "0000", tid, clientId: this.clientId, orderId, amount: String(amount), authToken: `tok-${tid}` };
    return { ...r, signature: FakePaymentGateway.sign(r) };
  }

  verifyAuthResult(r: AuthResult): boolean {
    return r.signature === FakePaymentGateway.sign(r);
  }

  private takeFault() {
    const f = this.failNext;
    this.failNext = null;
    return f;
  }

  async approve({ tid, amount }: { tid: string; amount: number }): Promise<PgResult<PgPayment>> {
    this.approveCalls++;
    const fault = this.takeFault();
    if (fault === "timeout_before") return { kind: "unknown", error: "timeout" };
    if (fault === "reject") return { kind: "rejected", code: "card_declined", message: "한도 초과" };
    const prev = this.payments.get(tid);
    if (prev) return prev.status === "paid" ? { kind: "ok", value: { ...prev } } : { kind: "rejected", code: "already_processed" };
    const auth = this.authed.get(tid);
    if (!auth || auth.amount !== amount) return { kind: "rejected", code: "amount_mismatch" };
    const p: PgPayment = { tid, orderId: auth.orderId, status: "paid", amount, balanceAmt: amount, card: { name: "시험카드", last4: "1234", installment: 0 } };
    this.payments.set(tid, p);
    if (fault === "timeout_after") return { kind: "unknown", error: "timeout" };
    return { kind: "ok", value: { ...p } };
  }

  async cancel(input: CancelInput): Promise<PgResult<CancelValue>> {
    this.cancelCalls++;
    const fault = this.takeFault();
    if (fault === "timeout_before") return { kind: "unknown", error: "timeout" };
    if (fault === "reject") return { kind: "rejected", code: "cancel_rejected" };
    const p = this.payments.get(input.tid);
    if (!p) return { kind: "rejected", code: "not_found" };
    if (this.cancelOrderIds.has(input.cancelOrderId)) return { kind: "rejected", code: "duplicate_order_id" };
    if (input.amount > p.balanceAmt) return { kind: "rejected", code: "over_balance" };
    this.cancelOrderIds.add(input.cancelOrderId);
    p.balanceAmt -= input.amount;
    p.status = p.balanceAmt === 0 ? "cancelled" : "partialCancelled";
    if (fault === "timeout_after") return { kind: "unknown", error: "timeout" };
    return { kind: "ok", value: { cancelledTid: `c-${input.cancelOrderId}`, status: p.status, balanceAmt: p.balanceAmt } };
  }

  async getPayment(tid: string): Promise<PgResult<PgPayment>> {
    const p = this.payments.get(tid);
    if (p) return { kind: "ok", value: { ...p } };
    const auth = this.authed.get(tid);
    if (auth) return { kind: "ok", value: { tid, orderId: auth.orderId, status: "ready", amount: auth.amount, balanceAmt: auth.amount } };
    return { kind: "rejected", code: "not_found" };
  }

  async netCancel(orderId: string): Promise<PgResult<null>> {
    for (const p of this.payments.values()) if (p.orderId === orderId && p.status === "paid") (p.status = "cancelled"), (p.balanceAmt = 0);
    return { kind: "ok", value: null };
  }

  verifyWebhook(body: unknown): { tid: string; status?: string } | null {
    const b = body as { tid?: unknown; signature?: unknown; status?: unknown };
    return typeof b?.tid === "string" && b.signature === `fake-hook:${b.tid}` ? { tid: b.tid, ...(typeof b.status === "string" ? { status: b.status } : {}) } : null;
  }
}
