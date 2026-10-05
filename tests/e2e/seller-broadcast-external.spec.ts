import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { NICKS, cleanupBroadcastQueue, resetBroadcastQueue } from "./seller-broadcast-db";
import { EXT_CARD_PREFIX, EXT_NICK, EXT_PRODUCT, cleanupExternalQueue, putExternalInLiveBroadcast, seedExternalQueue } from "./externalOrderDb";

// 외부 쇼핑몰 주문 출처 표시(#542): 방송 대시보드 대기 줄·방송 상세(외부 주문 목록, HIT 표)·HIT 카드 이력에 「외부 주문」 배지가 보이고,
// 내부 주문에는 보이지 않는다. 외부 주문은 주문 번호가 없어 HIT 이력의 주문 칸에 배지만 보인다. (폐기용 테스트 DB)
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.beforeEach(async () => {
  await resetBroadcastQueue();
  await seedExternalQueue();
});
const RUN_STARTED = new Date();
test.afterAll(async () => {
  await cleanupExternalQueue();
  await cleanupBroadcastQueue(RUN_STARTED);
});

async function login(page: Page, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}

test("외부 주문은 대기 줄·방송 상세·HIT 카드 이력에 「외부 주문」으로 표시되고 내부 주문에는 없다", async ({ page }) => {
  const title = `e2e-외부-${Date.now()}`;
  const card = `${EXT_CARD_PREFIX}-${Date.now()}`;
  await login(page, "/seller/broadcast");

  // 대시보드 대기: 외부 주문 줄에만 배지가 있다
  const waiting = page.getByTestId("bc-waiting");
  await expect(waiting.locator("tr", { hasText: EXT_NICK })).toContainText("다른 쇼핑몰 주문");
  for (const n of NICKS) await expect(waiting.locator("tr", { hasText: n })).not.toContainText("다른 쇼핑몰 주문");
  await expect(waiting.getByTestId("source-badge")).toHaveCount(1);

  // 방송 → 외부 주문을 방송 안으로 옮기고 HIT 카드 → 종료
  await page.getByLabel("방송 제목").fill(title);
  await page.getByRole("button", { name: "방송 시작" }).click();
  await expect(page.getByTestId("bc-live-badge")).toBeVisible();
  await putExternalInLiveBroadcast(card);
  await page.getByRole("button", { name: "방송 끝내기" }).click();
  await page.getByRole("dialog", { name: "방송을 끝내시겠습니까?" }).getByRole("button", { name: "방송 끝내기" }).click();
  await expect(page.getByTestId("bc-live-badge")).toHaveCount(0);

  // 방송 상세: 외부 주문 목록(금액 없음)과 HIT 표의 주문 칸
  await page.goto("/seller/broadcasts");
  await page.getByTestId("bh-list").locator("tr", { hasText: title }).getByTestId("bh-link").click();
  const ext = page.getByTestId("bd-external");
  await expect(ext).toContainText("다른 쇼핑몰 주문 1건");
  const row = page.getByTestId("bd-external-orders").locator("tr", { hasText: EXT_NICK });
  await expect(row).toContainText(EXT_PRODUCT);
  await expect(row).toContainText("다른 쇼핑몰 주문");
  await expect(page.getByTestId("bd-hits").locator("tr", { hasText: card }).getByTestId("source-badge")).toBeVisible();

  // HIT 카드 이력: 주문 번호가 없는 외부 주문 카드는 배지로 표시
  await page.goto("/seller/hit-cards");
  await expect(page.getByTestId("hit-list").locator("tr", { hasText: card }).getByTestId("source-badge")).toBeVisible();
});
