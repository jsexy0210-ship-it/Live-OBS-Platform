import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthResult, CancelInput, CancelValue, PaymentGateway, PgPayment, PgResult, PgStatus } from "./gateway";

// 나이스페이 서버 승인 모델 어댑터(공식 매뉴얼 nicepayments/nicepay-manual: payment-window-server·cancel·status-transaction·hook).
// 테스트(샌드박스) 결제만 한다(대표님 결정 2026-10-05). 실결제 주소(api.nicepay.co.kr)는 일부러 두지 않는다.
// 실결제 전환은 대표님 승인 뒤 별도 작업으로 한다.
export const NICEPAY_SANDBOX_API = "https://sandbox-api.nicepay.co.kr";
// 매뉴얼 권장: 연결 5초·읽기 30초. fetch는 둘을 나누지 않아 전체 30초로 건다.
export const NICEPAY_TIMEOUT_MS = 30_000;

const STATUSES: readonly PgStatus[] = ["paid", "ready", "failed", "cancelled", "partialCancelled", "expired"];

type Fetch = typeof fetch;

export function sha256Hex(s: string) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function sameHex(a: string, b: string) {
  const x = Buffer.from(a.toLowerCase(), "utf8");
  const y = Buffer.from(b.toLowerCase(), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// 승인 응답 card: cardName(카드사), cardNum(앞 6·끝 4만 보이는 마스킹 번호, 우리는 끝 4자리만 남김), cardQuota(할부 개월 문자열, "0" = 일시불).
function parseCard(v: unknown) {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  const name = isStr(c.cardName) ? c.cardName.slice(0, 20) : null;
  const last4 = isStr(c.cardNum) && /\d{4}$/.test(c.cardNum) ? c.cardNum.slice(-4) : null;
  const quota = typeof c.cardQuota === "string" && /^\d{1,2}$/.test(c.cardQuota) ? Number(c.cardQuota) : isInt(c.cardQuota) && c.cardQuota >= 0 && c.cardQuota <= 60 ? c.cardQuota : null;
  return name || last4 || quota !== null ? { name, last4, installment: quota } : null;
}

export class NicepaySandboxGateway implements PaymentGateway {
  readonly name = "nicepay";

  constructor(
    readonly clientId: string,
    private readonly secretKey: string,
    private readonly opts: { fetch?: Fetch; timeoutMs?: number; baseUrl?: string } = {},
  ) {
    if (!clientId || !secretKey) throw new Error("나이스페이 키가 없어요.");
  }

  verifyAuthResult(r: AuthResult): boolean {
    if (r.clientId !== this.clientId || !isStr(r.signature)) return false;
    return sameHex(r.signature, sha256Hex(r.authToken + r.clientId + r.amount + this.secretKey));
  }

  // 응답 서명: hex(sha256(tid + amount + ediDate + SecretKey)). 승인·취소·조회·웹훅 모두 같은 식이다.
  private validSignature(b: Record<string, unknown>) {
    if (!isStr(b.signature) || !isStr(b.tid) || !isInt(b.amount) || !isStr(b.ediDate)) return false;
    return sameHex(b.signature, sha256Hex(`${b.tid}${b.amount}${b.ediDate}${this.secretKey}`));
  }

  // 성공 응답을 검사해 결제 정보로 바꾼다. 형식이 틀리거나 서명이 안 맞으면 null(→ unknown, 조회로 확정).
  private parsePayment(b: Record<string, unknown>): PgPayment | null {
    if (!this.validSignature(b)) return null;
    if (!isStr(b.orderId) || !STATUSES.includes(b.status as PgStatus) || !isInt(b.balanceAmt)) return null;
    const card = parseCard(b.card);
    return { tid: b.tid as string, orderId: b.orderId, status: b.status as PgStatus, amount: b.amount as number, balanceAmt: b.balanceAmt, ...(card ? { card } : {}) };
  }

  private async call(method: "GET" | "POST", path: string, body?: object): Promise<PgResult<Record<string, unknown>>> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.opts.baseUrl ?? NICEPAY_SANDBOX_API}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secretKey}`).toString("base64")}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? NICEPAY_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (e) {
      // 타임아웃·연결 끊김: 처리됐는지 모른다. 비밀값이 섞이지 않게 오류 이름만 남긴다.
      return { kind: "unknown", error: e instanceof Error ? e.name : "network_error" };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { kind: "unknown", error: `invalid_body_${res.status}` };
    }
    if (res.status >= 500) return { kind: "unknown", error: `http_${res.status}` };
    const b = (json ?? {}) as Record<string, unknown>;
    if (!isStr(b.resultCode)) return { kind: "unknown", error: `invalid_body_${res.status}` };
    if (b.resultCode !== "0000") return { kind: "rejected", code: `nicepay_${b.resultCode}`.slice(0, 40), ...(isStr(b.resultMsg) ? { message: b.resultMsg.slice(0, 100) } : {}) };
    return { kind: "ok", value: b };
  }

  private toPayment(r: PgResult<Record<string, unknown>>): PgResult<PgPayment> {
    if (r.kind !== "ok") return r;
    const p = this.parsePayment(r.value);
    return p ? { kind: "ok", value: p } : { kind: "unknown", error: "invalid_response" };
  }

  async approve({ tid, amount }: { tid: string; amount: number }): Promise<PgResult<PgPayment>> {
    return this.toPayment(await this.call("POST", `/v1/payments/${encodeURIComponent(tid)}`, { amount }));
  }

  async cancel(input: CancelInput): Promise<PgResult<CancelValue>> {
    const r = await this.call("POST", `/v1/payments/${encodeURIComponent(input.tid)}/cancel`, {
      reason: input.reason.slice(0, 40),
      orderId: input.cancelOrderId,
      ...(input.partial ? { cancelAmt: input.amount } : {}),
    });
    if (r.kind !== "ok") return r;
    const p = this.parsePayment(r.value);
    if (!p) return { kind: "unknown", error: "invalid_response" };
    const cancelledTid = typeof r.value.cancelledTid === "string" ? r.value.cancelledTid : null;
    return { kind: "ok", value: { cancelledTid, status: p.status, balanceAmt: p.balanceAmt } };
  }

  async getPayment(tid: string): Promise<PgResult<PgPayment>> {
    return this.toPayment(await this.call("GET", `/v1/payments/${encodeURIComponent(tid)}`));
  }

  async netCancel(orderId: string): Promise<PgResult<null>> {
    const r = await this.call("POST", "/v1/payments/netcancel", { orderId });
    return r.kind === "ok" ? { kind: "ok", value: null } : r;
  }

  verifyWebhook(body: unknown): { tid: string; status?: string } | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    if (!this.validSignature(b)) return null;
    return { tid: b.tid as string, ...(STATUSES.includes(b.status as PgStatus) ? { status: b.status as string } : {}) };
  }
}
