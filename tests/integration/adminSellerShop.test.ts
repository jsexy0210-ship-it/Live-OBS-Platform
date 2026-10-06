import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as shopRoute } from "../../app/api/admin/sellers/[sellerId]/shop/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { createAdmin, createBuyer, createPaidOrderItem, createSeller, db, resetDb } from "./helpers";

// 마스터 관리자 파트너스 상세 쇼핑몰 탭(MA-012-2)
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000" };
async function cookieOf(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") {
  const a = await createAdmin(role);
  return `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
}
const get = (cookie: string, id: string) =>
  shopRoute(new Request(`http://localhost:3000/api/admin/sellers/${id}/shop`, { headers: { ...H, cookie } }), { params: Promise.resolve({ sellerId: id }) });
type Body = {
  shopName: string;
  brandColor: string | null;
  policyChecks: Record<string, string>;
  reportCount: number;
  products: { visible: number; total: number };
  members: number;
  month: { orders: number; amount: number };
  topProducts: { name: string; status: string; soldCount: number }[];
};

describe("파트너스 쇼핑몰 탭 GET /api/admin/sellers/{id}/shop", () => {
  it("설정 값·정책 점검·상품·회원·이번 달·상위 상품을 주고, 다른 파트너스 데이터는 섞이지 않는다. 조회 전용도 읽는다", async () => {
    const cookie = await cookieOf("READ_ONLY");
    const { seller, grade } = await createSeller();
    const other = await createSeller();
    const empty = (await (await get(cookie, seller.id)).json()) as Body;
    expect(empty).toMatchObject({ brandColor: null, reportCount: 0, members: 0, topProducts: [] });
    expect(empty.policyChecks).toEqual({ businessCsInfo: "MISSING", refundPolicy: "MISSING", minorRestriction: "MISSING" });

    await db.seller.update({ where: { id: seller.id }, data: { shopName: "카드숍 별빛", shopUsageGuide: "개봉 전 취소 가능", businessInfo: { businessNumber: "1234567890" } } });
    await db.sellerBrandColor.create({ data: { sellerId: seller.id, color: "#5B3DF6" } });
    await db.shopLegalNotice.create({ data: { sellerId: seller.id, csPhone: "02-000-0000", minorNotice: "" } });
    const buyer = await createBuyer(seller.id, grade.id);
    const otherBuyer = await createBuyer(other.seller.id, other.grade.id);
    const a = await createPaidOrderItem(seller.id, buyer.id);
    await createPaidOrderItem(seller.id, buyer.id);
    await createPaidOrderItem(other.seller.id, otherBuyer.id);
    await db.product.update({ where: { id: a.product.id }, data: { status: "SOLD_OUT" } });
    await db.product.create({ data: { sellerId: seller.id, name: "숨김 상품", price: 1000, status: "HIDDEN" } });
    await db.orderItem.update({ where: { id: a.item.id }, data: { quantity: 5, refundedQuantity: 1 } });

    const b = (await (await get(cookie, seller.id)).json()) as Body;
    expect(b).toMatchObject({ shopName: "카드숍 별빛", brandColor: "#5B3DF6", members: 1, products: { visible: 2, total: 3 } });
    expect(b.policyChecks).toEqual({ businessCsInfo: "DISPLAYED", refundPolicy: "WRITTEN", minorRestriction: "MISSING" });
    expect(b.month.orders).toBe(2);
    expect(b.topProducts[0]).toMatchObject({ status: "SOLD_OUT", soldCount: 4 });
    expect(b.topProducts).toHaveLength(2);
  });

  it("없는 파트너스·형식 오류 404, 로그인 없음 401", async () => {
    const cookie = await cookieOf("CS");
    expect((await get(cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await get(cookie, "abc")).status).toBe(404);
    const { seller } = await createSeller();
    expect((await get("", seller.id)).status).toBe(401);
  });
});
