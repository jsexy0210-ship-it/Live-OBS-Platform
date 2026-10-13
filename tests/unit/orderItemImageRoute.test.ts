import { beforeEach, describe, expect, it, vi } from "vitest";
import { forbidden } from "../../lib/server/authz/errors";

const mocks = vi.hoisted(() => ({ requireSeller: vi.fn(), getOrderItemImage: vi.fn() }));
vi.mock("../../lib/server/db", () => ({ prisma: {} }));
vi.mock("../../lib/server/authz/guards", () => ({ requireSeller: mocks.requireSeller }));
vi.mock("../../lib/server/orders/read", () => ({ getOrderItemImage: mocks.getOrderItemImage }));
import { GET } from "../../app/api/seller/orders/[orderId]/items/[itemId]/image/route";

const orderId = "12345678-1234-1234-1234-123456789012";
const itemId = "ABCDEFAB-1234-1234-1234-123456789012";
const request = () => new Request(`http://localhost/api/seller/orders/${orderId}/items/${itemId}/image`);
const params = (order = orderId, item = itemId) => ({ params: Promise.resolve({ orderId: order, itemId: item }) });
beforeEach(() => { vi.resetAllMocks(); mocks.requireSeller.mockResolvedValue({ sellerId: "seller" }); });

describe("주문 품목 이미지 경로", () => {
  it("표준 UUID를 받아 기존 주문 처리 권한으로만 읽고 캐시/콘텐츠 경계를 고정한다", async () => {
    mocks.getOrderItemImage.mockResolvedValue({ data: new Uint8Array([1, 2, 3]), contentType: "image/png", sha256: "a".repeat(64) });
    const response = await GET(request(), params());
    expect(response.status).toBe(200);
    expect(mocks.requireSeller.mock.calls[0][3]).toEqual({ allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    expect(mocks.getOrderItemImage).toHaveBeenCalledWith({}, { sellerId: "seller" }, orderId, itemId);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });
  it("잘못된 주문/품목 UUID는 저장소 접근 전에 404로 반환한다", async () => {
    for (const p of [params("12345678-1234-1234-123456789012"), params(orderId, "bad")]) {
      const response = await GET(request(), p);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.getOrderItemImage).not.toHaveBeenCalled();
  });
  it("권한 거부 응답에도 비공개/캐시 금지가 적용되고 바이트를 읽지 않는다", async () => {
    mocks.requireSeller.mockRejectedValue(forbidden());
    const response = await GET(request(), params());
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getOrderItemImage).not.toHaveBeenCalled();
  });
});
