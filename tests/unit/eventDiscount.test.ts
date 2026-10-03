import { describe, expect, it } from "vitest";
import { discountedUnit, eventFits, eventView, orderUnitPrice, type ProductEvent } from "../../lib/server/products/event";

const at = (iso: string) => new Date(iso);
const rate = (value: number, startsAt = "2026-10-01T00:00:00Z", endsAt = "2026-10-10T15:00:00Z"): ProductEvent => ({ type: "RATE", value, startsAt: at(startsAt), endsAt: at(endsAt) });

describe("이벤트 할인 계산", () => {
  it("할인율은 원 단위 버림, 할인 금액은 그대로 빼고, 기간(시작 ≤ 지금 < 종료) 밖이면 정가", () => {
    expect(discountedUnit(10500, rate(10))).toBe(9450);
    expect(discountedUnit(999, rate(33))).toBe(669); // 669.33 → 669
    expect(discountedUnit(10500, { ...rate(1), type: "AMOUNT", value: 3000 })).toBe(7500);
    const e = rate(10);
    expect(orderUnitPrice(10000, e, at("2026-09-30T23:59:59Z"))).toBe(10000);
    expect(orderUnitPrice(10000, e, at("2026-10-01T00:00:00Z"))).toBe(9000);
    expect(orderUnitPrice(10000, e, at("2026-10-10T15:00:00Z"))).toBe(10000);
    expect(orderUnitPrice(10000, null, at("2026-10-05T00:00:00Z"))).toBe(10000);
    const mid = at("2026-10-05T00:00:00Z");
    expect(eventFits({ ...e, type: "AMOUNT", value: 1000 }, 1000, [0], mid)).toBe(false);
    expect(eventFits({ ...e, type: "AMOUNT", value: 999 }, 1000, [0, 500], mid)).toBe(true);
    expect(eventFits(rate(90), 1, [0], mid)).toBe(false); // 1원 × 10% → 0원
    // 시작 전은 검증하고, 끝난 뒤는 보지 않는다
    expect(eventFits({ ...e, type: "AMOUNT", value: 1000 }, 1000, [0], at("2026-09-01T00:00:00Z"))).toBe(false);
    expect(eventFits({ ...e, type: "AMOUNT", value: 1000 }, 1000, [0], at("2026-10-10T15:00:00Z"))).toBe(true);
  });

  it("마감 임박: 종료일이 오늘(KST)이면 「오늘 마감」, 7일 안이면 「D-n」, 하루 안이면 남은 시간 문구. 시작 전·끝난 뒤는 배지 없음", () => {
    // 종료 2026-10-10 15:00Z = KST 10월 11일 00:00
    const e = rate(10, "2026-10-01T00:00:00Z", "2026-10-10T14:59:00Z"); // KST 10월 10일 23:59
    expect(eventView(e, 10000, at("2026-10-10T11:47:00Z"))).toMatchObject({ active: true, badge: "오늘 마감", remainingLabel: "3시간 12분 남았어요", discountedPrice: 9000 });
    expect(eventView(e, 10000, at("2026-10-07T03:00:00Z"))).toMatchObject({ badge: "D-3", remainingLabel: null });
    expect(eventView(e, 10000, at("2026-10-01T03:00:00Z"))).toMatchObject({ badge: null });
    expect(eventView(e, 10000, at("2026-10-10T14:30:00Z"))).toMatchObject({ remainingLabel: "29분 남았어요" });
    expect(eventView(e, 10000, at("2026-09-30T00:00:00Z"))).toMatchObject({ active: false, badge: null, remainingSeconds: null });
    expect(eventView(e, 10000, at("2026-10-11T00:00:00Z"))).toMatchObject({ active: false, badge: null });
    expect(eventView(null, 10000, at("2026-10-05T00:00:00Z"))).toBeNull();
  });
});
