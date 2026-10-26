import { beforeEach, expect, it, vi } from "vitest";

const owned = vi.hoisted(() => ({ shop: vi.fn(), session: vi.fn(), detail: vi.fn(), view: vi.fn() }));
vi.mock("../../lib/server/db", () => ({ prisma: { seller: { findUnique: owned.shop } } }));
vi.mock("../../lib/server/auth/session", () => ({ resolveBuyerSession: owned.session }));
vi.mock("../../lib/server/products/shopCatalog", () => ({ shopProductDetail: owned.detail }));
vi.mock("../../lib/server/stats/funnel", () => ({ recordProductView: owned.view }));
import { GET } from "../../app/api/shop/[slug]/products/[productId]/route";

const product = { id: "owned-product", options: [{ id: "owned-option", soldOut: false }], detail: ["existing-detail"], shipping: { baseFee: 3000 } };
beforeEach(() => {
  vi.clearAllMocks();
  owned.shop.mockResolvedValue({ id: "owned-shop" });
  owned.session.mockResolvedValue({ member: { id: "owned-member", gradeId: "owned-grade" } });
  owned.detail.mockResolvedValue(product);
});
const read = (query: string) => GET(new Request(`http://localhost:3100/product${query}`), { params: Promise.resolve({ slug: "owned-shop", productId: product.id }) });

it("명시 옵션 조회는 기존 상세 읽기를 거쳐 옵션만 반환하며 상세 조회 추적을 호출하지 않는다", async () => {
  const response = await read("?view=options");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ product: { id: product.id, options: product.options } });
  expect(owned.detail).toHaveBeenCalledWith(expect.anything(), "owned-shop", product.id, "owned-grade");
  expect(owned.view).not.toHaveBeenCalled();
});
it.each(["", "?view=other"])("기본 상세 조회 %s 는 원 DTO·캐시·회원 조회 추적을 유지한다", async query => {
  const response = await read(query);
  expect(await response.json()).toEqual({ product });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(owned.view).toHaveBeenCalledExactlyOnceWith(expect.anything(), { sellerId: "owned-shop", buyerMemberId: "owned-member" }, product.id);
});
it("옵션 조회도 기존 가시성 조회의 404를 유지하고 추적하지 않는다", async () => {
  owned.detail.mockResolvedValue(null);
  const response = await read("?view=options");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not_found" });
  expect(owned.view).not.toHaveBeenCalled();
});
