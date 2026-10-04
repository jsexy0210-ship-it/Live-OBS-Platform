import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { NICKS, cleanupBroadcastQueue, resetBroadcastQueue } from "./seller-broadcast-db";

// OV-001·OV-002 기본 오버레이(/overlay/{token}): 발급한 토큰 주소가 열리고, 방송 시작·개봉 시작이 새로 고침 없이 반영되며,
// 재발급하면 옛 주소는 주문 표시가 지워지고 주소 확인 안내만 남는다. 모두 실제 API(발급·방송·주문대기)를 부른다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const [A, B, C] = NICKS;
const RUN_STARTED = new Date();

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.beforeEach(async () => resetBroadcastQueue());
test.afterAll(async () => cleanupBroadcastQueue(RUN_STARTED));

// 파트너스 화면과 같은 출처에서 API를 부른다(쿠키·Origin을 브라우저가 붙인다)
async function call<T>(page: Page, path: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const r = await fetch(path, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    },
    { path, method, body },
  );
}

async function issue(page: Page): Promise<string> {
  const r = await call<{ token: string }>(page, "/api/seller/overlay/token", "POST", {});
  expect(r.status).toBe(200);
  return r.data.token;
}

test("발급한 주소가 열리고 방송·개봉 변화가 바로 반영되며, 재발급하면 옛 주소는 끊긴다", async ({ page, context }) => {
  test.setTimeout(60_000);
  await page.goto("/seller/login?next=/seller/products");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === "/seller/products");
  const token = await issue(page);

  const ov = await context.newPage();
  await ov.setViewportSize({ width: 1080, height: 1920 });
  await ov.goto(`/overlay/${token}`);
  await expect(ov.getByTestId("overlay-idle")).toHaveText("방송 준비 중이에요");
  // 배경 투명(OBS 브라우저 소스 위에 그대로 얹힌다)
  expect(await ov.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");

  // 방송 시작 → 대기 3건이 순서대로
  expect((await call(page, "/api/seller/broadcast/start", "POST", { title: "오버레이 e2e" })).status).toBe(200);
  const queue = ov.getByTestId("overlay-queue");
  await expect(queue.locator(".ovl-q-nm")).toHaveText([A, B, C], { timeout: 5000 });
  await expect(ov.getByTestId("overlay-idle")).toHaveCount(0);

  // 개봉 시작 → 현재 주문 카드에 A, 대기에서 빠짐
  const snap = await call<{ waiting: { id: string; version: number; nicknameSnapshot: string }[] }>(page, "/api/seller/queue");
  const first = snap.data.waiting.find((w) => w.nicknameSnapshot === A)!;
  expect((await call(page, `/api/seller/queue/${first.id}/start`, "POST", { expectedVersion: first.version })).status).toBe(200);
  await expect(ov.getByTestId("overlay-opening")).toContainText(A, { timeout: 5000 });
  await expect(queue.locator(".ovl-q-nm")).toHaveText([B, C]);
  if (SHOTS) await ov.screenshot({ path: "tests/e2e/screenshots/OV-001-1080x1920.png", omitBackground: true });

  // 가로형도 같은 상태
  const land = await context.newPage();
  await land.setViewportSize({ width: 1920, height: 1080 });
  await land.goto(`/overlay/${token}?ratio=16x9`);
  await expect(land.getByTestId("overlay-opening")).toContainText(A);
  await expect(land.getByTestId("overlay-queue").locator(".ovl-q-nm")).toHaveText([B, C]);
  if (SHOTS) await land.screenshot({ path: "tests/e2e/screenshots/OV-002-1920x1080.png", omitBackground: true });
  await land.close();

  // 재발급 → 옛 주소 API는 404, 열려 있던 옛 오버레이는 주문을 지우고 안내만(15초 확인 주기 안)
  const next = await issue(page);
  expect(next).not.toBe(token);
  expect((await call(page, `/api/overlay/${token}/state`)).status).toBe(404);
  await expect(ov.getByTestId("overlay-gone")).toBeVisible({ timeout: 20_000 });
  await expect(ov.getByTestId("overlay-opening")).toHaveCount(0);
  await expect(ov.getByTestId("overlay-queue")).toHaveCount(0);

  // 새 주소는 지금 상태를 보여 준다
  await ov.goto(`/overlay/${next}`);
  await expect(ov.getByTestId("overlay-opening")).toContainText(A);
  await ov.close();
});

test("없는 토큰 주소는 주문을 보여 주지 않고 주소 확인 안내만 보인다", async ({ page }) => {
  await page.goto("/overlay/not-a-real-token");
  await expect(page.getByTestId("overlay-gone")).toHaveText("오버레이 주소가 바뀌었어요. 파트너스 관리자에서 새 주소를 넣어 주세요");
  await expect(page.getByTestId("overlay-queue")).toHaveCount(0);
});
