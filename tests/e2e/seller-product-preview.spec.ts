import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// SA-013 상품 상세 미리보기: 구매자 화면 틀(모바일 · PC), 점검 항목, 공유 링크. 숨김 상품은 미리보기만 되고 「쇼핑몰에서 열기」는 막힌다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const NAME = `E2E미리보기 ${Date.now().toString(36)}`;
const createdIds = new Set<string>();

test.beforeAll(() => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

test.afterEach(async ({ page }) => {
  for (const id of createdIds) {
    const response = await page.request.delete(`/api/seller/products/${id}`, { headers: { origin: new URL(page.url()).origin } });
    expect(response.ok(), `미리보기 상품 정리 실패: ${response.status()}`).toBe(true);
    createdIds.delete(id);
  }
});

async function login(page: Page, next: string, email = "demo-owner@example.com") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await page.waitForURL((u) => u.pathname === next.split("?")[0]);
}

async function create(page: Page, status: "ON_SALE" | "HIDDEN", stock: number) {
  const id = await page.evaluate(
    async ([name, st, qty]) => {
      const r = await fetch("/api/seller/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description: "정품 미개봉 박스예요.", price: 99000, status: st, options: [{ name: "기본", stock: qty }] }),
      });
      const j = (await r.json()) as { product?: { id: string }; id?: string };
      const id = j.product?.id ?? j.id;
      if (!r.ok || !id) throw new Error(`미리보기 상품 생성 실패: ${r.status}`);
      return id;
    },
    [`${NAME} ${status}`, status, stock] as const,
  );
  createdIds.add(id);
  return id;
}

test("미리보기: 판매 중 상품은 구매자 화면 · 점검 항목 · 공유 링크가 보이고, PC로 바꿀 수 있으며, 쇼핑몰에서 열 수 있다", async ({ page }) => {
  await login(page, "/seller/products");
  const id = await create(page, "ON_SALE", 12);
  await page.goto(`/seller/products/${id}/preview`);
  await expect(page.getByTestId("preview-name")).toHaveText(`${NAME} ON_SALE`);
  await expect(page.getByTestId("preview-price")).toContainText("99,000");
  const checks = page.getByTestId("preview-checks");
  await expect(checks).toContainText("재고 12");
  await expect(checks.getByText("주의").first()).toBeVisible(); // 이미지 없음
  // 점검 항목은 서버(미리보기 API)가 정한 값 그대로: 이미지 · 카테고리 없음은 주의, 설명 · 가격은 한 행
  await expect(checks).toContainText("상품 이미지가 없습니다");
  await expect(checks).toContainText("카테고리가 지정되지 않았습니다");
  await expect(checks.getByText("설명 · 가격 · 할인")).toHaveCount(1);
  await expect(page.getByText("방송 주문대기 상품")).toHaveCount(0); // 방송에 올리지 않은 상품
  await expect(page.getByLabel("상품 주소")).toHaveValue(new RegExp(`/shop/[^/]+/products/${id}$`));
  // 검수 증거: E2E_SCREENSHOTS=1일 때만 SA-013을 1440 · 1024로 저장한다
  if (process.env.E2E_SCREENSHOTS === "1") {
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `tests/e2e/screenshots/SA-013-preview-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await page.getByRole("button", { name: "PC", exact: true }).click();
  await expect(page.getByTestId("preview-frame")).toHaveClass(/is-pc/);
  await expect(page.getByRole("link", { name: "쇼핑몰에서 열기" })).toHaveAttribute("href", new RegExp(`/shop/[^/]+/products/${id}$`));
  await expect(page.getByRole("link", { name: "상품 수정" })).toHaveAttribute("href", `/seller/products/${id}`);
});

test("미리보기: 숨김 상품은 안내가 보이고 「쇼핑몰에서 열기」가 눌리지 않으며, 없는 상품은 안내한다", async ({ page }) => {
  await login(page, "/seller/products");
  const id = await create(page, "HIDDEN", 3);
  await page.goto(`/seller/products/${id}/preview`);
  await expect(page.getByText("구매자에게 보이지 않습니다")).toBeVisible();
  await expect(page.getByRole("button", { name: "쇼핑몰에서 열기" })).toBeDisabled();
  await expect(page.getByTestId("preview-checks")).toContainText("방송 중에 품절될 수 있습니다");
  await page.goto("/seller/products/00000000-0000-4000-8000-000000000000/preview");
  await expect(page.getByText("상품을 찾을 수 없습니다")).toBeVisible();
});
