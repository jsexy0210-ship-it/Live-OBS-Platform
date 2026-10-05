import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-027 배송 처리: 발송 대기 주문에 송장을 저장하면 배송 중으로, 배송 완료 처리하면 배송 완료로 옮겨 가는지 실제 API로 확인한다.
// dev-seed 데모 주문 중 발송 대기 1건을 실행마다 배송 완료까지 보낸다(폐기용 DB). 발송 대기가 다 떨어지면 DB를 새로 만들고 dev-seed를 다시 돌린다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

const post = (page: Page, path: string) => page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(path));

test("대표자: 송장 저장 → 배송 중 → 배송 완료로 옮겨 가고, 잘못된 송장은 그 줄에만 실패를 알린다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fshipping");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/shipping$/);
  await expect(page.getByRole("link", { name: "배송", exact: true })).toHaveAttribute("href", "/seller/shipping");

  const rows = page.getByTestId("shipment-row");
  await expect(rows.first()).toBeVisible();
  const ready = await page.evaluate(async () => (await (await fetch("/api/seller/shipments?tab=ready&limit=200")).json()).shipments as { orderId: string; orderNo: number }[]);
  expect(ready.length, "발송 대기 주문이 없습니다. dev-seed를 새 DB에 다시 돌려 주십시오").toBeGreaterThan(1);
  const [a, b] = ready;
  await shot(page, "SA-027-shipping-ready");

  // a는 올바른 송장, b는 너무 짧은 송장 → a만 저장되고 b 줄에 실패 사유가 남는다
  const tracking = `E2E${Date.now()}`;
  // 일괄로 한진택배를 고른 뒤 a 줄만 롯데택배로 바꾼다
  await page.getByLabel("택배사 일괄 선택").selectOption("HANJIN");
  await expect(page.getByLabel(`주문 ${b.orderNo} 택배사`)).toHaveValue("HANJIN");
  await page.getByLabel(`주문 ${a.orderNo} 택배사`).selectOption("LOTTE");
  await page.getByLabel(`주문 ${a.orderNo} 송장번호`).fill(tracking);
  await page.getByLabel(`주문 ${b.orderNo} 송장번호`).fill("12");
  const shipped = post(page, "/api/seller/shipments");
  await page.getByRole("button", { name: "송장 저장 (2)" }).click();
  const shippedRes = await shipped;
  const sent = shippedRes.request().postDataJSON().items as { orderId: string; courier: string }[];
  expect(sent.find((x) => x.orderId === a.orderId)?.courier).toBe("LOTTE");
  expect(sent.find((x) => x.orderId === b.orderId)?.courier).toBe("HANJIN");
  const results = (await shippedRes.json()).results as { orderId: string; ok: boolean }[];
  expect(results.find((r) => r.orderId === a.orderId)?.ok).toBe(true);
  expect(results.find((r) => r.orderId === b.orderId)?.ok).toBe(false);
  await expect(page.getByText("1건 송장 저장 · 1건은 처리하지 못했습니다. 빨간 글씨를 확인해 주십시오")).toBeVisible();
  await expect(page.getByLabel(`주문 ${a.orderNo} 송장번호`)).toHaveCount(0);
  await expect(rows.filter({ has: page.getByLabel(`주문 ${b.orderNo} 송장번호`) })).toContainText("송장번호");
  await expect(page.locator(".err[role=alert]")).toHaveCount(1);

  // 배송 중 탭에서 찾아 배송 완료 처리
  await page.getByRole("button", { name: "배송 중", exact: true }).click();
  await page.getByLabel("배송 검색").fill(tracking);
  const row = rows.filter({ hasText: tracking });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("롯데택배");
  await shot(page, "SA-027-shipping-in-transit");
  await row.getByRole("checkbox").check();
  const delivered = post(page, "/api/seller/shipments/deliver");
  await page.getByRole("button", { name: "배송 완료 처리 (1)" }).click();
  expect((await delivered).status()).toBe(200);
  await expect(page.getByText("1건 배송 완료")).toBeVisible();
  await expect(row).toHaveCount(0);

  await page.getByRole("button", { name: "배송 완료", exact: true }).click();
  await expect(rows.filter({ hasText: tracking })).toHaveCount(1);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await shot(page, "SA-027-shipping-delivered");
});

test("주문·배송 권한이 없는 직원은 메뉴가 안 보이고, 주소로 들어와도 권한 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fshipping");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/shipping$/);
  await expect(page.getByText("필요한 권한: 주문·배송", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "배송", exact: true })).toHaveCount(0);
});
