import { expect, test, type Page } from "@playwright/test";
import { resetCartInDb } from "./cartDb";

// SH-004 장바구니(운영 빌드 + 데모 시드). 데모 구매자(demo-buyer1@example.com, 비밀번호 E2E_PASSWORD)의 장바구니를 시작·끝에 비운다.
// 데모 상품: 스타라이트 부스터 박스·문라이트 컬렉션 박스(판매 중), 드래곤 소울 부스터(품절).
const SLUG = "demo-shop";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
const seed = () =>
  resetCartInDb(SLUG, "demo-buyer1@example.com", [
    { productName: "스타라이트 부스터 박스", quantity: 2 },
    { productName: "문라이트 컬렉션 박스", quantity: 1 },
    { productName: "드래곤 소울 부스터", quantity: 1 },
  ]);

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(() => resetCartInDb(SLUG, "demo-buyer1@example.com", []));

test("비회원: 로그인 안내", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/cart`);
  await expect(page.getByRole("heading", { name: "장바구니", level: 1 })).toBeVisible();
  await expect(page.getByText("로그인하면 장바구니를 볼 수 있어요.")).toBeVisible();
  await expect(page.getByRole("link", { name: "로그인", exact: true }).last()).toHaveAttribute("href", /\/login\?next=/);
});

test.describe.serial("로그인 구매자", () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await seed();
    await login(page, baseURL!);
  });

  test("PC: 표(열 제목 가운데·값 왼쪽), 품절 줄은 선택 불가, 합계는 고른 상품만", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/shop/${SLUG}/cart`);
    await expect(page.getByRole("list", { name: "주문 단계" }).getByText("장바구니")).toBeVisible();
    const rows = page.locator(".cart-tbl tbody tr");
    await expect(rows).toHaveCount(3);
    for (const th of await page.locator(".cart-tbl th").all()) expect(await th.evaluate((el) => getComputedStyle(el).textAlign)).toBe("center");
    for (const td of await rows.first().locator("td").all()) expect(await td.evaluate((el) => getComputedStyle(el).textAlign)).toBe("left");
    const out = page.locator(".cart-tbl tr.is-out");
    await expect(out).toContainText("드래곤 소울 부스터");
    await expect(out).toContainText("품절 · 주문에서 빠져요");
    await expect(out.getByRole("checkbox")).toBeDisabled();
    const api = (await (await page.request.get(`/api/shop/${SLUG}/cart`)).json()) as { items: { status: string; lineTotal: number }[] };
    const expected = api.items.filter((l) => l.status === "available").reduce((s, l) => s + l.lineTotal, 0);
    await expect(page.getByRole("complementary", { name: "주문 금액" })).toContainText("상품 금액 (2개)");
    await expect(page.getByRole("complementary", { name: "주문 금액" }).locator(".cart-row b")).toHaveText(won(expected));
    await expect(page.getByRole("link", { name: `${won(expected)} 주문하기` })).toHaveAttribute("href", /\/checkout\?ids=.+,.+$/);
    await page.screenshot({ path: "tests/e2e/screenshots/SH-004-cart-1440.png", fullPage: true });
    await page.getByRole("checkbox", { name: "전체 선택" }).uncheck();
    await expect(page.getByRole("button", { name: "주문할 상품을 골라 주세요" })).toBeDisabled();
  });

  test("수량 바꾸기·삭제 되돌리기·선택 삭제(확인 창)·품절 상품 삭제·빈 장바구니", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/shop/${SLUG}/cart`);
    const first = page.locator(".cart-tbl tbody tr", { hasText: "스타라이트 부스터 박스" });
    await expect(first.locator(".cart-qty span")).toHaveText("2");
    await first.getByRole("button", { name: "수량 늘리기" }).click();
    await expect(first.locator(".cart-qty span")).toHaveText("3");
    await first.getByRole("button", { name: "수량 줄이기" }).click();
    await expect(first.locator(".cart-qty span")).toHaveText("2");

    await page.locator(".cart-tbl tbody tr", { hasText: "문라이트 컬렉션 박스" }).getByRole("button", { name: "삭제" }).click();
    await expect(page.getByRole("status")).toContainText("장바구니에서 뺐어요");
    await expect(page.locator(".cart-tbl tbody tr")).toHaveCount(2);
    await page.getByRole("button", { name: "되돌리기" }).click();
    await expect(page.locator(".cart-tbl tbody tr")).toHaveCount(3);

    await page.getByRole("button", { name: "선택 삭제" }).click();
    const dlg = page.getByRole("dialog", { name: "2개를 지울까요?" });
    await expect(dlg).toContainText("장바구니에서만 빠져요.");
    await dlg.getByRole("button", { name: "닫기" }).click();
    await expect(dlg).toBeHidden();
    await expect(page.locator(".cart-tbl tbody tr")).toHaveCount(3);
    await page.getByRole("button", { name: "선택 삭제" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "지우기" }).click();
    await expect(page.locator(".cart-tbl tbody tr")).toHaveCount(1);
    await page.getByRole("button", { name: "품절 상품 삭제" }).click();
    await expect(page.getByRole("heading", { name: "장바구니가 비어 있어요" })).toBeVisible();
    await expect(page.getByRole("link", { name: "상품 보러 가기" })).toHaveAttribute("href", `/shop/${SLUG}/products`);
  });

  test("머리 장바구니 배지가 개수를 보여 주고, 삭제하면 따라 바뀐다. 비회원은 배지 없음", async ({ page, browser }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/shop/${SLUG}`);
    const count = ((await (await page.request.get(`/api/shop/${SLUG}/cart/count`)).json()) as { count: number }).count;
    expect(count).toBeGreaterThan(0);
    const badge = page.locator(".shop-hics .shop-badge");
    await expect(badge).toHaveText(String(count));
    await expect(page.getByRole("link", { name: `장바구니 (${count}개)` })).toBeVisible();
    await page.goto(`/shop/${SLUG}/cart`);
    await page.locator(".cart-tbl tbody tr", { hasText: "문라이트 컬렉션 박스" }).getByRole("button", { name: "삭제" }).click();
    await expect(badge).toHaveText(String(count - 1));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".shop-tabbar .shop-badge")).toHaveText(String(count - 1));
    const guest = await browser.newPage({ baseURL: page.url().split("/shop/")[0] });
    await guest.goto(`/shop/${SLUG}`);
    await expect(guest.locator(".shop-badge")).toHaveCount(0);
    await guest.close();
  });

  test("휴대폰 390: 줄이 카드로 쌓이고 가로 스크롤 없음, 합계 상자는 아래 바 위에 붙는다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/shop/${SLUG}/cart`);
    await expect(page.locator(".cart-tbl thead")).toBeHidden();
    await expect(page.locator(".cart-tbl tbody tr")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const sum = await page.getByRole("complementary", { name: "주문 금액" }).boundingBox();
    const bar = await page.getByRole("navigation", { name: "바로 가기" }).boundingBox();
    expect(sum!.y + sum!.height).toBeLessThanOrEqual(bar!.y);
    await page.screenshot({ path: "tests/e2e/screenshots/SH-004-cart-390.png", fullPage: false });
  });
});
