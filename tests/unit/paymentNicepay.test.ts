import { describe, expect, it } from "vitest";
import { NICEPAY_SANDBOX_API, NicepaySandboxGateway, sha256Hex } from "../../lib/server/payments/nicepay";
import { goodsNameOf, payableAmount } from "../../lib/server/payments/service";

// 시험용 키(실제 키 아님)
const CLIENT = "S2_test_client";
const SECRET = "test_secret_key";

type Call = { url: string; init: RequestInit };

function gateway(respond: (call: Call) => Response | Promise<Response>, timeoutMs?: number) {
  const calls: Call[] = [];
  const fetchMock = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { gw: new NicepaySandboxGateway(CLIENT, SECRET, { fetch: fetchMock, timeoutMs }), calls };
}

const signed = (b: { tid: string; amount: number; ediDate: string }) => sha256Hex(`${b.tid}${b.amount}${b.ediDate}${SECRET}`);
const paidBody = (over: Record<string, unknown> = {}) => {
  const b = { resultCode: "0000", resultMsg: "정상 처리되었습니다.", tid: "T1", orderId: "O1", status: "paid", amount: 13000, balanceAmt: 13000, ediDate: "2026-10-05T10:00:00.000+0900", ...over };
  return { ...b, signature: signed(b as { tid: string; amount: number; ediDate: string }) };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("나이스페이 어댑터(샌드박스)", () => {
  it("승인은 샌드박스 주소로 Basic 인증·금액만 보내고, 응답 서명을 검증한다", async () => {
    const { gw, calls } = gateway(() => json(paidBody()));
    expect(await gw.approve({ tid: "T1", amount: 13000 })).toEqual({ kind: "ok", value: { tid: "T1", orderId: "O1", status: "paid", amount: 13000, balanceAmt: 13000 } });
    expect(calls[0].url).toBe(`${NICEPAY_SANDBOX_API}/v1/payments/T1`);
    expect(calls[0].url.startsWith("https://sandbox-api.nicepay.co.kr/")).toBe(true);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ amount: 13000 });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("응답 서명이 틀리거나 형식이 틀리면 결과 모름(unknown)으로 본다", async () => {
    expect((await gateway(() => json({ ...paidBody(), signature: "00" })).gw.approve({ tid: "T1", amount: 13000 })).kind).toBe("unknown");
    expect((await gateway(() => json({ ...paidBody(), amount: "13000" })).gw.approve({ tid: "T1", amount: 13000 })).kind).toBe("unknown");
    expect((await gateway(() => new Response("<html>", { status: 200 })).gw.approve({ tid: "T1", amount: 13000 })).kind).toBe("unknown");
    expect((await gateway(() => json({ resultCode: "9999" }, 502)).gw.approve({ tid: "T1", amount: 13000 })).kind).toBe("unknown");
  });

  it("resultCode가 0000이 아니면 거절(rejected)", async () => {
    expect(await gateway(() => json({ resultCode: "3011", resultMsg: "카드 거절" })).gw.approve({ tid: "T1", amount: 13000 })).toEqual({ kind: "rejected", code: "nicepay_3011" });
  });

  it("타임아웃은 결과 모름(unknown)", async () => {
    const { gw } = gateway(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(call.init.signal?.reason));
        }),
      20,
    );
    expect(await gw.approve({ tid: "T1", amount: 13000 })).toEqual({ kind: "unknown", error: "TimeoutError" });
  });

  it("전액 취소는 cancelAmt를 빼고, 부분 취소는 넣는다(취소 주문번호는 요청 id)", async () => {
    const { gw, calls } = gateway(() => json({ ...paidBody({ status: "partialCancelled", balanceAmt: 10000 }), cancelledTid: "C1" }));
    expect(await gw.cancel({ tid: "T1", cancelOrderId: "K1", amount: 3000, partial: true, reason: "환불" })).toEqual({
      kind: "ok",
      value: { cancelledTid: "C1", status: "partialCancelled", balanceAmt: 10000 },
    });
    expect(calls[0].url).toBe(`${NICEPAY_SANDBOX_API}/v1/payments/T1/cancel`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ reason: "환불", orderId: "K1", cancelAmt: 3000 });
    await gw.cancel({ tid: "T1", cancelOrderId: "K2", amount: 13000, partial: false, reason: "환불" });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ reason: "환불", orderId: "K2" });
  });

  it("인증 결과·웹훅 서명 검증", () => {
    const { gw } = gateway(() => json({}));
    const auth = { authResultCode: "0000", tid: "T1", clientId: CLIENT, orderId: "O1", amount: "13000", authToken: "AT" };
    const sig = sha256Hex(`AT${CLIENT}13000${SECRET}`);
    expect(gw.verifyAuthResult({ ...auth, signature: sig })).toBe(true);
    expect(gw.verifyAuthResult({ ...auth, signature: sig.toUpperCase() })).toBe(true);
    expect(gw.verifyAuthResult({ ...auth, amount: "100", signature: sig })).toBe(false);
    expect(gw.verifyAuthResult({ ...auth, clientId: "other", signature: sha256Hex(`ATother13000${SECRET}`) })).toBe(false);
    expect(gw.verifyWebhook(paidBody())).toEqual({ tid: "T1" });
    expect(gw.verifyWebhook({ ...paidBody(), amount: 1 })).toBeNull();
    expect(gw.verifyWebhook("x")).toBeNull();
  });

  it("키가 없으면 만들 수 없다", () => {
    expect(() => new NicepaySandboxGateway("", SECRET)).toThrow();
    expect(() => new NicepaySandboxGateway(CLIENT, "")).toThrow();
  });
});

describe("결제 금액·상품명", () => {
  it("품목 + 배송비 − 쿠폰 − 적립금", () => {
    expect(payableAmount({ items: [{ unitPrice: 5000, quantity: 2 }], shippingFee: 3000, rewardUsedAmount: 500, couponRedemption: { discountAmount: 1000 } })).toBe(11500);
    expect(payableAmount({ items: [{ unitPrice: 5000, quantity: 1 }], shippingFee: 0, rewardUsedAmount: 0, couponRedemption: null })).toBe(5000);
  });

  it("상품명은 40바이트 안으로 줄이고 나머지 건수를 붙인다", () => {
    const name = goodsNameOf([{ productNameSnapshot: "아주 긴 이름의 포켓몬 카드 부스터 박스 한정판" }, { productNameSnapshot: "b" }]);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(40);
    expect(name.endsWith(" 외 1건")).toBe(true);
  });
});
