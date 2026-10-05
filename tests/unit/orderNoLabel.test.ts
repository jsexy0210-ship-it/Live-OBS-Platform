import { describe, expect, it } from "vitest";
import { orderNoLabel, parseOrderNoLabel } from "../../lib/server/orders/orderNoLabel";

describe("사람이 읽는 주문번호", () => {
  it("생성일(KST) yyyyMMdd + 하이픈 + 주문번호 4자리 0 채움, 9999를 넘으면 자릿수가 늘어난다", () => {
    expect(orderNoLabel(new Date("2026-10-02T03:00:00Z"), 409)).toBe("20261002-0409");
    expect(orderNoLabel(new Date("2026-10-05T01:00:00+09:00"), 4)).toBe("20261005-0004");
    expect(orderNoLabel(new Date("2026-10-05T01:00:00+09:00"), 9999)).toBe("20261005-9999");
    expect(orderNoLabel(new Date("2026-10-05T01:00:00+09:00"), 10000)).toBe("20261005-10000");
    expect(orderNoLabel(new Date("2026-10-05T01:00:00+09:00"), 123456)).toBe("20261005-123456");
  });

  it("날짜는 KST 기준이다: UTC로는 전날 15시 이후도 KST 다음 날", () => {
    expect(orderNoLabel(new Date("2026-10-01T15:00:00Z"), 1)).toBe("20261002-0001");
    expect(orderNoLabel(new Date("2026-10-01T14:59:59Z"), 1)).toBe("20261001-0001");
    expect(orderNoLabel(new Date("2026-12-31T15:00:00Z"), 1)).toBe("20270101-0001");
    expect(orderNoLabel(new Date("2026-02-28T14:59:00Z"), 7)).toBe("20260228-0007");
  });

  it("라벨을 읽으면 주문번호와 그날(KST) 범위를 준다. 형식이 아니거나 없는 날짜는 null", () => {
    const p = parseOrderNoLabel("20261005-0004")!;
    expect(p.orderNo).toBe(4);
    expect(p.from.toISOString()).toBe("2026-10-04T15:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-10-05T15:00:00.000Z");
    expect(parseOrderNoLabel(" 20261005-10000 ")?.orderNo).toBe(10000);
    for (const bad of ["", "4", "0004", "20261005", "20261005-", "20261005-abc", "2026-10-05-0004", "20261305-0001", "20260230-0001", "20261005-0004x", "20261005_0004", "20261005-1234567890"]) {
      expect(parseOrderNoLabel(bad), bad).toBeNull();
    }
    // 만든 라벨은 다시 읽힌다
    const at = new Date("2026-10-01T15:30:00Z");
    const back = parseOrderNoLabel(orderNoLabel(at, 77))!;
    expect(back.orderNo).toBe(77);
    expect(at >= back.from && at < back.to).toBe(true);
  });
});
