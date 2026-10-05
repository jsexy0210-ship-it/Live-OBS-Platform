import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 공통 시각 규격(2026-10-05 대표님 지시 「전체 UI 현대화」 1단계, styles/tokens.css --ui-*).
// 실제 화면에서 계산된 스타일(computed style)로 컨트롤 높이·모서리·글자 크기와 가로 넘침을 확인한다.
// PC(1440)는 입력·버튼 기본 44px(검색·필터 40, 표 안 보조 32), 휴대폰(390)은 입력·주요 버튼 48px·입력 글자 16px, 보조 버튼 조작 영역 44px 이상.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

type Box = { h: number; r: string; fs: string };

async function boxes(page: Page, sel: string): Promise<Box[]> {
  return page.locator(sel).evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => {
        const c = getComputedStyle(e);
        return { h: Math.round(e.getBoundingClientRect().height), r: c.borderTopLeftRadius, fs: c.fontSize };
      }),
  );
}

async function noSideScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
}

for (const [width, inputH, inputFs, btnMin] of [
  [1440, 44, "14px", 44],
  [390, 48, "16px", 48],
] as const) {
  test(`로그인 화면 입력·버튼 규격 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/seller/login", "/admin/login"]) {
      await page.goto(path);
      const inputs = await boxes(page, "input.inp");
      expect(inputs.length).toBeGreaterThan(0);
      for (const b of inputs) expect(b).toEqual({ h: inputH, r: "8px", fs: inputFs });
      const submit = page.getByRole("button", { name: "로그인", exact: true });
      const h = await submit.evaluate((e) => e.getBoundingClientRect().height);
      expect(h).toBeGreaterThanOrEqual(btnMin);
      expect(await submit.evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).toBe("8px");
      await noSideScroll(page);
    }
  });

  test(`파트너스 대표 화면 공통 규격·가로 넘침 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/seller/login?next=${encodeURIComponent("/seller/orders")}`);
    await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
    await expect(page).toHaveURL(/\/seller\/orders$/);
    for (const path of ["/seller/orders", "/seller/broadcast", "/seller/hit-cards", "/seller/products", "/seller/overlay"]) {
      await page.goto(path);
      await expect(page.locator(".loc-bar")).toBeVisible();
      await noSideScroll(page);
      // 버튼·입력 모서리는 8px 하나. 높이는 compact(32) 이상, 휴대폰은 조작 영역 44 이상
      for (const b of await boxes(page, ".main .btn")) {
        expect(b.r).toBe("8px");
        expect(b.h).toBeGreaterThanOrEqual(width < 768 ? 44 : 32);
      }
      for (const b of await boxes(page, ".main input.inp:not([type=checkbox]):not([type=radio]), .main select.inp")) {
        expect(b.r).toBe("8px");
        expect(b.h).toBeGreaterThanOrEqual(width < 768 ? 44 : 40);
      }
    }
  });
}

test("경로는 상단 경로 줄 한 곳에만 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/broadcast")}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/broadcast$/);
  await expect(page.locator(".loc-bar")).toContainText("방송 대시보드");
  await expect(page.locator(".main .au-ph")).toBeVisible();
  await expect(page.locator(".main .au-ph")).not.toContainText("›");
  // 화면 제목 20px/28px
  const title = page.locator(".au-ph-title");
  expect(await title.evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e).lineHeight])).toEqual(["20px", "28px"]);
});

test("구매자 상품 상세 휴대폰 폭: 주요 버튼 48px 이상, 입력 16px, 가로 넘침 없음", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/shop/demo-shop");
  const first = page.locator('a[href*="/shop/demo-shop/products/"]').first();
  await page.goto((await first.getAttribute("href")) ?? "/shop/demo-shop");
  await noSideScroll(page);
  const btns = await boxes(page, ".btn-lg");
  expect(btns.length).toBeGreaterThan(0);
  for (const b of btns) expect(b.h).toBeGreaterThanOrEqual(48);
  for (const b of await boxes(page, "input.inp, select.inp")) {
    expect(b.h).toBeGreaterThanOrEqual(48);
    expect(b.fs).toBe("16px");
  }
});
