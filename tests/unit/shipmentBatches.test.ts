import { describe, expect, it } from "vitest";
import { SHIPMENT_BATCH_MAX } from "../../lib/server/orders/shipping";
import { sendInBatches, type BatchResult } from "../../components/seller/shipping/sendInBatches";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `o${i}`);
const okAll = (chunk: string[]): { results: BatchResult[] } => ({ results: chunk.map((orderId) => ({ orderId, ok: true })) });

describe("배송 처리 묶음 나누기", () => {
  it("한도는 서버와 같은 상수를 쓴다", () => {
    expect(SHIPMENT_BATCH_MAX).toBe(100);
  });

  it("250건은 100·100·50으로 나뉘고 줄별 결과가 순서대로 합쳐진다", async () => {
    const sizes: number[] = [];
    const { results, lastFail } = await sendInBatches(ids(250), (x) => x, async (chunk) => {
      sizes.push(chunk.length);
      return okAll(chunk);
    });
    expect(sizes).toEqual([100, 100, 50]);
    expect(results.map((r) => r.orderId)).toEqual(ids(250));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(lastFail).toBeNull();
  });

  it("정확히 한도(100건)는 한 번, 101건은 두 번 보낸다", async () => {
    let calls = 0;
    await sendInBatches(ids(100), (x) => x, async (c) => (calls++, okAll(c)));
    expect(calls).toBe(1);
    calls = 0;
    await sendInBatches(ids(101), (x) => x, async (c) => (calls++, okAll(c)));
    expect(calls).toBe(2);
  });

  it("두 번째 묶음이 통째로 실패해도 그 묶음만 실패로 남고 세 번째가 이어진다", async () => {
    let n = 0;
    const { results, lastFail } = await sendInBatches(ids(250), (x) => x, async (chunk) => (++n === 2 ? { failMessage: "네트워크 오류" } : okAll(chunk)));
    expect(n).toBe(3);
    expect(results).toHaveLength(250);
    expect(results.slice(0, 100).every((r) => r.ok)).toBe(true);
    expect(results.slice(100, 200).every((r) => !r.ok && r.message === "네트워크 오류")).toBe(true);
    expect(results.slice(200).every((r) => r.ok)).toBe(true);
    expect(lastFail).toBe("네트워크 오류");
  });

  it("묶음 안에서 일부만 실패한 결과는 그대로 합쳐진다", async () => {
    const { results } = await sendInBatches(ids(120), (x) => x, async (chunk) => ({
      results: chunk.map((orderId) => ({ orderId, ok: orderId !== "o105", error: orderId === "o105" ? "not_shippable" : undefined })),
    }));
    expect(results.filter((r) => !r.ok)).toEqual([{ orderId: "o105", ok: false, error: "not_shippable" }]);
  });

  it("빈 목록은 요청을 보내지 않는다", async () => {
    let calls = 0;
    const { results } = await sendInBatches([] as string[], (x) => x, async (c) => (calls++, okAll(c)));
    expect(calls).toBe(0);
    expect(results).toEqual([]);
  });
});
