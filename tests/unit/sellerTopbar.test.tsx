import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Location = { group: string; item: string; exact: boolean; groupHref?: string; itemHref?: string };
const shell = vi.hoisted(() => ({ pathname: "/seller/products/stock", loc: null as Location | null }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useContext: () => ({ me: { access: "paid" }, trialDaysLeft: null, loc: shell.loc }) }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), usePathname: () => shell.pathname }));
vi.mock("next/link", () => ({ default: ({ href, className, children }: { href: string; className?: string; children: ReactNode }) => createElement("a", { href, className }, children) }));
import { Topbar } from "../../components/seller/SellerShell";

beforeEach(() => {
  shell.pathname = "/seller/products/stock";
  shell.loc = { group: "상품", item: "재고", exact: true, groupHref: "/seller/products", itemHref: "/seller/products/stock" };
});
const render = (crumb: string, showCurrent?: boolean) => renderToStaticMarkup(createElement(Topbar, { crumb, showCurrent }));
const text = (html: string) => html.replace(/<[^>]*>/g, "");

describe("Topbar의 현재 화면 표시 선택", () => {
  it("기본값은 exact 메뉴의 기존 두 단계와 링크 동작을 유지한다", () => {
    const html = render("상품 › 재고 › 재고 수정");
    expect(text(html)).toBe("상품›재고");
    expect(html).toContain('href="/seller/products"');
    expect(html).not.toContain('href="/seller/products/stock"');
  });
  it("SA014는 exact 메뉴에서도 FINAL의 세 단계를 표시하고 현재 화면은 링크가 아니다", () => {
    const html = render("상품 › 재고 › 재고 수정", true);
    expect(text(html)).toBe("상품›재고›재고 수정");
    expect(html).toContain('href="/seller/products"');
    expect(html).toContain('href="/seller/products/stock"');
    expect(html).not.toMatch(/<a\b[^>]*>\s*재고 수정\s*<\/a>/);
  });
  it("기존 하위 화면은 선택 없이도 현재 화면을 계속 표시한다", () => {
    shell.loc!.exact = false;
    expect(text(render("판매 › 상품 › 옵션 수정"))).toBe("상품›재고›옵션 수정");
  });
  it("선택했어도 메뉴와 같은 현재 이름을 중복 표시하지 않는다", () => {
    expect(text(render("상품 › 재고 › 재고", true))).toBe("상품›재고");
  });
  it("메뉴 위치가 없으면 기존 fallback 문구를 그대로 표시한다", () => {
    shell.loc = null;
    const html = render("상품 › 재고 › 재고 수정", true);
    expect(text(html)).toBe("상품›재고›재고 수정");
    expect(html).not.toContain("href=");
  });
  it("홈의 중복 경로를 숨기는 기본 동작을 유지한다", () => {
    shell.pathname = "/seller";
    shell.loc = { group: "홈", item: "홈", exact: true, groupHref: "/seller", itemHref: "/seller" };
    expect(render("홈 › 홈")).toBe("");
  });
});
