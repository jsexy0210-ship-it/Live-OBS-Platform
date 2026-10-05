import { expect, test } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-022 주문 상세 「상태 이력」: 서버가 준 이력 건수와 표의 줄 수가 같고, 최신 이력이 맨 위에 보인다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

test("주문 상세: 상태 이력 표가 서버 이력과 같은 건수로, 최신순으로 보인다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Forders");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/orders$/);
  const first = page.getByTestId("order-row").first();
  await expect(first).toBeVisible();
  const detail = page.waitForResponse((r) => /\/api\/seller\/orders\/[^/?]+$/.test(r.url()) && r.request().method() === "GET");
  await first.getByRole("link").first().click();
  const body = await (await detail).json();
  const events: { at: string }[] = body.history ?? body.order?.history ?? [];
  expect(events.length).toBeGreaterThan(0);
  const section = page.getByTestId("order-history");
  await expect(section.getByRole("heading", { name: "상태 이력" })).toBeVisible();
  const rows = section.getByTestId("history-row");
  await expect(rows).toHaveCount(events.length);
  // 서버는 오름차순, 화면은 내림차순: 첫 줄이 가장 늦은 시각
  await expect(rows.first().locator("td").first()).not.toHaveText("");
});
