import { describe, expect, it } from "vitest";
import { restockNotifyAt } from "../../lib/server/shop-restock-alerts/service";

// KST = UTC+9. 08:00~20:59 KST는 바로, 21:00~07:59 KST는 다음 아침 8시(KST)
const at = (iso: string) => restockNotifyAt(new Date(iso)).toISOString();
describe("재입고 알림 발송 시각", () => {
  it("낮에는 바로", () => {
    expect(at("2026-10-05T00:00:00Z")).toBe("2026-10-05T00:00:00.000Z"); // 09:00 KST
    expect(at("2026-10-05T11:59:59Z")).toBe("2026-10-05T11:59:59.000Z"); // 20:59 KST
  });
  it("21시 이후는 다음 날 8시", () => {
    expect(at("2026-10-05T12:00:00Z")).toBe("2026-10-05T23:00:00.000Z"); // 21:00 KST → 10-06 08:00 KST
    expect(at("2026-10-05T15:30:00Z")).toBe("2026-10-05T23:00:00.000Z"); // 00:30 KST(10-06)은 그날 8시
  });
  it("자정~8시 전은 그날 8시", () => {
    expect(at("2026-10-05T22:59:59Z")).toBe("2026-10-05T23:00:00.000Z"); // 07:59 KST
    expect(at("2026-10-05T23:00:00Z")).toBe("2026-10-05T23:00:00.000Z"); // 08:00 KST
  });
});
