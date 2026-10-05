import { describe, expect, it } from "vitest";
import { sanitizeNext, NEXT_SCOPE } from "../../lib/client/navigation/safeNext";
import { canGoBackTo, onNavigate, previousOf, scopeOf } from "../../lib/client/navigation/navStack";

describe("sanitizeNext", () => {
  const seller = NEXT_SCOPE.seller;
  it("영역 안 경로와 쿼리를 유지한다", () => {
    expect(sanitizeNext("/seller/products?q=a&sort=low", seller)).toBe("/seller/products?q=a&sort=low");
    expect(sanitizeNext("/seller", seller)).toBe("/seller");
  });
  it("외부·이중 슬래시·역슬래시·..·제어문자·다른 영역을 버린다", () => {
    for (const bad of [
      "https://evil.com", "//evil.com", "/\\evil.com", "/seller/../admin", "/seller/%2e%2e/admin",
      "/seller%5Cx", "/seller/a\nb", "/admin/x", "/sellerx", "seller/x", "", "javascript:alert(1)",
    ]) expect(sanitizeNext(bad, seller), bad).toBeNull();
    expect(sanitizeNext(undefined, seller)).toBeNull();
  });
  it("구매자는 같은 쇼핑몰만 받는다", () => {
    const s = NEXT_SCOPE.shop("demo-shop");
    expect(sanitizeNext("/shop/demo-shop/me", s)).toBe("/shop/demo-shop/me");
    expect(sanitizeNext("/shop/other/me", s)).toBeNull();
  });
});

describe("navStack", () => {
  it("push·pop·replace를 따라간다", () => {
    let s = onNavigate([], "/seller/products", "push");
    s = onNavigate(s, "/seller/products?q=a", "replace");
    expect(s).toEqual(["/seller/products?q=a"]);
    s = onNavigate(s, "/seller/products/1", "push");
    expect(previousOf(s)).toBe("/seller/products?q=a");
    s = onNavigate(s, "/seller/products?q=a", "pop");
    expect(s).toEqual(["/seller/products?q=a"]);
  });
  it("알 수 없는 pop은 기록을 버린다", () => {
    expect(onNavigate(["/a", "/b"], "/c", "pop")).toEqual(["/c"]);
  });
  it("같은 영역의 인증 화면이 아닌 이전 화면에만 돌아간다", () => {
    expect(scopeOf("/shop/x/me?a=1")).toBe("/shop/x");
    expect(canGoBackTo("/seller/products?q=a", "/seller/products")).toBe(true);
    expect(canGoBackTo("/seller/login", "/seller/products")).toBe(false);
    expect(canGoBackTo("/shop/other/p/1", "/shop/x")).toBe(false);
    expect(canGoBackTo("/admin", "/seller/products")).toBe(false);
    expect(canGoBackTo(null, "/seller/products")).toBe(false);
  });
});
