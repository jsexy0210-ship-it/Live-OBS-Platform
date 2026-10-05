import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { NICKS, cleanupBroadcastQueue, purgeE2eHitCards, resetBroadcastQueue } from "./seller-broadcast-db";

// SA-001 방송 대시보드의 HIT 카드 등록 창: 방송 중에만 열리고(버튼·Ctrl+H), 기본 대상은 지금 개봉 중인 주문이며,
// 등록하면 서버에 카드가 남고(주문 연결) 요약의 HIT 수가 오른다. 입력 중 닫으면 확인을 묻는다. 실제 API(/api/seller/hit-cards)를 부른다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const [A] = NICKS;

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.beforeEach(async () => resetBroadcastQueue());
const RUN_STARTED = new Date();
test.afterAll(async () => {
  await purgeE2eHitCards();
  await cleanupBroadcastQueue(RUN_STARTED);
});

async function login(page: Page) {
  await page.goto("/seller/login?next=%2Fseller%2Fbroadcast");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === "/seller/broadcast");
}

test("방송 전에는 등록할 수 없고, 방송 중 Ctrl+H로 열어 개봉 중 주문에 HIT 카드를 등록한다", async ({ page }) => {
  const card = `e2e-hit-${Date.now()}`;
  await login(page);
  // 방송 전: 버튼이 꺼져 있고 Ctrl+H도 창을 열지 않는다
  await expect(page.getByTestId("bc-hit-open")).toBeDisabled();
  await page.locator("body").press("Control+h");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "방송 시작" }).click();
  await expect(page.getByTestId("bc-live-badge")).toBeVisible();
  await page.getByRole("button", { name: /개봉 시작/ }).click();
  await expect(page.getByTestId("bc-opening")).toContainText(A);

  await page.locator("body").press("Control+h");
  const dlg = page.getByRole("dialog", { name: "HIT 카드 등록" });
  await expect(dlg.getByLabel("대상 주문")).toHaveValue(/.+/);
  await expect(dlg.getByLabel("대상 주문").locator("option:checked")).toContainText(`${A} · 지금 개봉 중`);
  await expect(dlg.getByRole("button", { name: "HIT 카드 등록" })).toBeDisabled();

  // 입력 중 Esc: 닫지 않고 확인을 묻는다 → 계속 작성
  await dlg.getByLabel("카드명").fill(card);
  await page.keyboard.press("Escape");
  await expect(dlg.getByRole("alert")).toContainText("저장하지 않은 변경");
  await dlg.getByRole("button", { name: "계속 작성" }).click();

  await dlg.getByLabel("메모 (파트너스만)").fill("e2e 메모");
  await dlg.getByRole("button", { name: "HIT 카드 등록" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 서버에 남고 개봉 중 주문에 연결되며, 요약의 HIT 수가 1이 된다
  const list = await (await page.request.get("/api/seller/hit-cards")).json();
  const mine = list.items.find((c: { cardName: string }) => c.cardName === card);
  expect(mine).toMatchObject({ nickname: A, note: "e2e 메모" });
  expect(mine.order).not.toBeNull();
  await expect(page.getByTestId("bc-summary")).toContainText("1장");
});
