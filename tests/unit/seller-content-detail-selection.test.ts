import { describe, expect, it } from "vitest";
import { readCouponSelection, storeCouponSelection } from "../../app/(seller)/seller/(shell)/coupons/selection";
import { listReturnTo, cursorScope, rememberCursorPosition, takeCursorPosition } from "../../app/(seller)/seller/(shell)/banners/_shared/detailNavigation";

const memory = () => { const data = new Map<string, string>(); return { data, setItem: (key: string, value: string) => { data.set(key, value); }, getItem: (key: string) => data.get(key) ?? null, removeItem: (key: string) => { data.delete(key); } }; };
describe("쿠폰 선택 전달", () => {
  it("기존 무상한 선택을 자르지 않고 같은 쇼핑몰에서 새로 읽는다", () => {
    const storage = memory(), ids = Array.from({ length: 1200 }, (_, i) => `coupon-${i}`);
    const key = storeCouponSelection("shop-a", ids, storage)!;
    expect(key.length).toBeLessThan(100);
    expect(readCouponSelection(key, "shop-a", storage)).toEqual(ids);
    expect(readCouponSelection(key, "shop-b", storage)).toBeNull();
    expect(JSON.parse(storage.getItem(key)!)).toEqual({ scope: "coupon-stop", sellerId: "shop-a", ids });
  });
  it("없는 키·다른 범위·깨진 값·중복 ID는 임의 선택으로 복구하지 않는다", () => {
    const storage = memory(), key = storeCouponSelection("shop-a", ["one"], storage)!;
    expect(readCouponSelection(key + "missing", "shop-a", storage)).toBeNull();
    expect(readCouponSelection("other-app:key", "shop-a", storage)).toBeNull();
    for (const value of ["{", "null", JSON.stringify({ scope: "other", sellerId: "shop-a", ids: ["one"] }), JSON.stringify({ scope: "coupon-stop", sellerId: "shop-a", ids: ["one", "one"] }), JSON.stringify({ scope: "coupon-stop", sellerId: "shop-a", ids: [12] })]) {
      storage.setItem(key, value); expect(readCouponSelection(key, "shop-a", storage)).toBeNull();
    }
  });
  it("저장소를 쓸 수 없거나 선택이 비면 전송을 만들지 않는다", () => {
    const storage = { setItem: () => { throw new Error("unavailable"); } };
    expect(storeCouponSelection("shop-a", ["one"], storage)).toBeNull();
    expect(storeCouponSelection("shop-a", [], memory())).toBeNull();
    expect(storeCouponSelection("shop-a", ["one", "one"], memory())).toBeNull();
    expect(readCouponSelection("streamshop:coupon-stop:one", "shop-a", { getItem: () => { throw new Error("unavailable"); } })).toBeNull();
  });
});
describe("상세 목록 복귀", () => {
  const list = "/seller/coupons";
  it("정확한 목록의 조회 조건·쪽을 유지한다", () => { const url = new URL(listReturnTo("/seller/coupons?q=코드&page=3", list), "http://local.invalid"); expect(url.pathname).toBe(list); expect(url.searchParams.get("q")).toBe("코드"); expect(url.searchParams.get("page")).toBe("3"); });
  it("외부·상세·인접 메뉴·잘못된 쿼리 값은 직접 진입의 기본 목록으로 간다", () => {
    for (const value of [undefined, ["/seller/coupons"], "//example.com/seller/coupons", "https://example.com/seller/coupons", "/seller/coupons/one", "/seller/coupons-other", "/seller/staff", "/seller/coupons/../staff", "/seller/coupons\\other"]) expect(listReturnTo(value, list)).toBe(list);
  });
});

describe("상세 새로고침 뒤 커서 복귀", () => {
  it("같은 tenant·actor·메뉴·조건의 커서만 한 번 소비하고 검색 원문을 저장하지 않는다", async () => {
    const storage = memory(), scope = await cursorScope("reviews", "shop-a", "actor-a", "?q=private-query&rating=5");
    rememberCursorPosition("reviews", scope, { page: 2, cursors: [undefined, "page-two"] }, storage);
    const raw = storage.getItem("streamshop:reviews:return")!;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["cursors", "page", "scope"]);
    expect(raw).not.toContain("private-query"); expect(raw).not.toContain("shop-a"); expect(raw).not.toContain("actor-a");
    expect(takeCursorPosition("reviews", scope, storage)).toEqual({ page: 2, cursors: [undefined, "page-two"] });
    expect(takeCursorPosition("reviews", scope, storage)).toBeNull();
  });
  it("다른 사용자·메뉴·조건 또는 손상된 위치는 1쪽 기본값으로 돌아가며 오래된 기록을 남기지 않는다", async () => {
    const storage = memory(), scope = await cursorScope("reviews", "shop-a", "actor-a", "?rating=5");
    const others = await Promise.all([cursorScope("reviews", "shop-b", "actor-a", "?rating=5"), cursorScope("reviews", "shop-a", "actor-b", "?rating=5"), cursorScope("buyer-inquiries", "shop-a", "actor-a", "?rating=5"), cursorScope("reviews", "shop-a", "actor-a", "?rating=4")]);
    for (const other of others) {
      rememberCursorPosition("reviews", scope, { page: 2, cursors: [undefined, "two"] }, storage);
      expect(takeCursorPosition("reviews", other, storage)).toBeNull();
      expect(storage.getItem("streamshop:reviews:return")).toBeNull();
    }
    for (const raw of ["{", "null", JSON.stringify({ scope, page: 2, cursors: [null] }), JSON.stringify({ scope, page: 2, cursors: [null, 12] }), JSON.stringify({ scope, page: 0, cursors: [] })]) {
      storage.setItem("streamshop:reviews:return", raw); expect(takeCursorPosition("reviews", scope, storage)).toBeNull();
    }
  });
});
