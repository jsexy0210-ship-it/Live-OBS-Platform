import { describe, expect, it } from "vitest";
import { readCouponSelection, storeCouponSelection } from "../../app/(seller)/seller/(shell)/coupons/selection";
import { listReturnTo } from "../../app/(seller)/seller/(shell)/banners/_shared/detailNavigation";

const memory = () => { const data = new Map<string, string>(); return { data, setItem: (key: string, value: string) => { data.set(key, value); }, getItem: (key: string) => data.get(key) ?? null }; };
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
