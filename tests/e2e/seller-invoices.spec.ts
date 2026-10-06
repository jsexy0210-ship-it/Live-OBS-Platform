import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-027 송장 발급 · SA-028 출력·추적(모의 발급): 발송 대기 주문 → 합배송·주소 확인 → 발급 → 출력 → 추적.
// dev-seed 데모 주문의 발송 대기 주문을 실행마다 발급한다(폐기용 DB). 발송 대기가 다 떨어지면 DB를 새로 만들고 dev-seed를 다시 돌린다.
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

test("대표자: 송장 발급 → 출력 안 한 송장 확인 → 추적 상세", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fshipping%2Finvoices");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/shipping\/invoices$/);
  // 실행마다 같은 출발점: 기본 택배사를 비워 둔다
  const putCourier = (c: string | null) =>
    page.evaluate(async (courier) => {
      const cur = (await (await fetch("/api/seller/shipping-policy")).json()).policy;
      return (await fetch("/api/seller/shipping-policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...cur, defaultCourier: courier }) })).status;
    }, c);
  expect(await putCourier(null)).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "송장 발급" })).toBeVisible();
  const tabs = page.getByRole("navigation").filter({ hasText: "출력 · 추적" }).first();
  await expect(tabs.getByRole("link", { name: "송장 발급" })).toHaveAttribute("aria-current", /.+/);
  await expect(page.getByRole("list", { name: "송장 발급 단계" })).toContainText("2. 합배송 · 주소 확인");
  // 기본 택배사가 없으면 발급할 수 없다(배송 설정 안내) → 정한 뒤 다시 연다
  await expect(page.getByRole("link", { name: "배송 설정" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^송장 \d+개 발급$/ })).toBeDisabled();
  expect(await putCourier("HANJIN")).toBe(200);
  await page.reload();
  await expect(page.getByText("고른 주문")).toBeVisible();
  await expect(page.getByText("배송 접수 업체는 아직 정해지지 않아")).toBeVisible();
  await shot(page, "SA-027-invoices");

  const issueBtn = page.getByRole("button", { name: /^송장 \d+개 발급$/ });
  await expect(issueBtn).toBeEnabled();
  await issueBtn.click();
  await expect(page.getByText(/송장 \d+개를 발급했습니다 · 출력 전까지 집하되지 않습니다/).first()).toBeVisible();
  await shot(page, "SA-027-invoices-done");

  await page.goto("/seller/shipping/tracking");
  await expect(page.getByRole("heading", { level: 1, name: "송장 출력 · 추적" })).toBeVisible();
  await expect(page.getByText("모의 데이터입니다")).toBeVisible();
  await expect(page.getByRole("button", { name: /출력 안 한 송장 [1-9]\d*개 출력/ })).toBeVisible();
  await page.getByRole("link", { name: /^발급됨 \d+$/ }).click();
  await expect(page.getByText("아직 출력 안 함").first()).toBeVisible();
  await shot(page, "SA-028-tracking");
  // 한 송장을 출력(모의)하면 출력됨으로 옮겨 가고, 그 줄의 「추적」에서 이벤트가 보인다
  const printed = await page.evaluate(async () => {
    const list = (await (await fetch("/api/seller/invoices?status=ISSUED")).json()).invoices as { id: string }[];
    const r = await fetch("/api/seller/invoices/print", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "LABEL_100X150", invoiceIds: [list[0].id] }) });
    return r.status;
  });
  expect(printed).toBe(200);
  await page.reload();
  await page.getByRole("link", { name: /^출력됨 \d+$/ }).click();
  await expect(page.getByText("집하 전").first()).toBeVisible();
  await page.getByRole("button", { name: "추적" }).first().click();
  await expect(page.getByRole("cell", { name: "업체 연동 전 · 모의", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "발급", exact: true }).first()).toBeVisible();
  await shot(page, "SA-028-tracking-detail");
});
