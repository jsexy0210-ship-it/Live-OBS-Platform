import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-031 적립 정책 중 적립금 지급 시점: 결제하면 바로 / 배송 완료 후(기본)를 바꿔 저장해 확인한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function login(page: Page, email: string) {
  await page.goto("/seller/login?next=%2Fseller%2Frewards");
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/rewards$/);
}

async function saveOk(page: Page) {
  await page.getByRole("button", { name: "정책 저장", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "적립 정책을 저장하시겠습니까?" });
  await expect(dialog).toContainText("이미 지급한 적립금은 그대로입니다");
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/seller/reward-policy") && r.ok()),
    dialog.getByRole("button", { name: "정책 저장", exact: true }).click(),
  ]);
  await expect(page.getByText("적립 정책을 저장했습니다", { exact: false }).first()).toBeVisible();
}

test("적립금 지급 시점: 기본은 배송 완료 후, 결제하면 바로로 바꾸면 저장되고 다시 열어도 그대로다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  // 이전 실행이 바꾼 값에 기대지 않게 기본값으로 맞춘다
  const status = await page.evaluate(async () =>
    (await fetch("/api/seller/reward-policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ earnTiming: "ON_DELIVERY" }) })).status,
  );
  expect(status).toBe(200);
  await page.reload();

  // 메뉴 「적립금」에서 들어온다
  await expect(page.getByRole("link", { name: "적립금", exact: true })).toHaveAttribute("href", "/seller/rewards");
  await expect(page.getByRole("radio", { name: "배송 완료 후 지급 (기본)" })).toBeChecked();
  await expect(page.getByText("적립 금액은 결제 때 정해지고 지급 시점만 달라집니다", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "정책 저장", exact: true })).toBeDisabled();
  await shot(page, "SA-031-earn-timing");

  await page.getByRole("radio", { name: "결제하면 바로 지급" }).check();
  await saveOk(page);
  await page.reload();
  await expect(page.getByRole("radio", { name: "결제하면 바로 지급" })).toBeChecked();

  // 되돌려 둔다
  await page.getByRole("radio", { name: "배송 완료 후 지급 (기본)" }).check();
  await saveOk(page);
  await page.reload();
  await expect(page.getByRole("radio", { name: "배송 완료 후 지급 (기본)" })).toBeChecked();
});

test("회원·적립금 권한이 없는 직원은 메뉴가 안 보이고, 주소로 들어와도 권한 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Frewards");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/rewards$/);
  await expect(page.getByText("필요한 권한: 회원·적립금", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "적립금", exact: true })).toHaveCount(0);
});

test("등급별 적립률·회수·사용 조건·1위 보너스: 입력 오류는 칸에서 알리고, 저장하면 이력에 남고 미리보기가 바뀐다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  const rows = page.getByTestId("rate-row");
  await expect(rows.first()).toBeVisible();
  await expect(page.getByText("마지막 적립 후 3년이 지나면 소멸")).toBeVisible();
  await expect(page.getByRole("option", { name: /마이너스/ })).toHaveCount(0);
  const first = rows.first();
  const card = first.getByRole("textbox", { name: /카드 결제 적립률/ });
  const old = await card.inputValue();

  // 범위·자릿수 오류는 칸 옆에서 알리고 저장하지 않는다
  await card.fill("12");
  await page.getByRole("button", { name: "정책 저장", exact: true }).click();
  await expect(first.getByRole("alert")).toContainText("적립률은 0~10% 사이로 입력해 주십시오");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 바꾼 적립률 → 확인 창 → 저장 → 이력에 한 줄, 칸은 저장한 값
  const next = old === "2.5" ? "3.0" : "2.5";
  await card.fill(next);
  await page.getByLabel("최소 사용 금액").fill("1500");
  await page.getByRole("checkbox", { name: "인기 카드 1위 보너스 사용" }).check();
  await page.getByRole("textbox", { name: "인기 카드 1위 보너스 금액" }).fill("5000");
  await saveOk(page);
  await expect(card).toHaveValue(next);
  await shot(page, "SA-031");
  const hist = page.getByTestId("policy-history");
  await expect(hist).toContainText(`카드 ${old === "" ? "없음" : old} → ${next}%`);
  await expect(hist).toContainText("최소 사용 금액 1,000 → 1,500원");
  await expect(hist).toContainText("인기 카드 1위 보너스 사용 안 함 → 5,000원");

  // 변경 취소는 저장한 값으로 되돌린다
  await card.fill("1.1");
  await page.getByRole("button", { name: "변경 취소" }).click();
  await expect(card).toHaveValue(next);

  // 되돌려 둔다
  await card.fill(old);
  await page.getByLabel("최소 사용 금액").fill("1000");
  await page.getByRole("checkbox", { name: "인기 카드 1위 보너스 사용" }).uncheck();
  await saveOk(page);
});
