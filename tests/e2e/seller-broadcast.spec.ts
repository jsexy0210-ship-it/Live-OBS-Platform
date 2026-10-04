import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { NICKS, bumpLiveVersion, cleanupBroadcastQueue, queueStatuses, resetBroadcastQueue } from "./seller-broadcast-db";

// SA-001 방송 대시보드: 메뉴로 들어가기 · 방송 전 대기 순서 변경 · 방송 시작 · 개봉 시작 · 타이머(단축키·창) · 완료 · 되돌리기 · 취소(사유) · 방송 종료,
// 다른 창 실시간 반영(SSE), 결과가 불분명한 요청은 성공으로 보이지 않음, 방송 진행 권한 없는 직원은 메뉴·화면 없음.
// 모두 실제 API를 부르고, 끝난 뒤 DB 상태를 확인한다(폐기용 테스트 DB, seller-broadcast-db.ts가 대기 3건을 준비).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const [A, B, C] = NICKS;

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.beforeEach(async () => resetBroadcastQueue());
const RUN_STARTED = new Date();
test.afterAll(async () => cleanupBroadcastQueue(RUN_STARTED));

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

async function login(page: Page, email: string, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
}

const waitingNames = (page: Page) => page.getByTestId("bc-waiting").locator("tr .t-l1");
const toast = (page: Page) => page.getByRole("status").filter({ has: page.locator(".toast") });

test("대표자: 방송 시작부터 개봉·타이머·완료·되돌리기·취소·종료까지 실제로 처리된다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/products");
  await expect(page).toHaveURL(/\/seller\/products$/);
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "방송", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/broadcast$/);

  // 방송 전: 대기 3건, 개봉은 방송을 시작해야 할 수 있다
  await expect(page.getByRole("heading", { name: /방송 전 대기 3건/ })).toBeVisible();
  await expect(page.getByTestId("bc-opening-empty")).toHaveText("방송을 시작하면 개봉할 수 있습니다");
  await expect(waitingNames(page)).toHaveText([A, B, C]);
  await shot(page, "SA-001-before");

  // 순서 변경: C를 위로 → A, C, B
  await page.getByRole("button", { name: `${C} 위로` }).click();
  await expect(toast(page)).toContainText("순서를 바꿨습니다");
  await expect(waitingNames(page)).toHaveText([A, C, B]);

  // 방송 시작
  await page.getByLabel("방송 제목").fill("e2e 라이브");
  await page.getByRole("button", { name: "방송 시작" }).click();
  await expect(page.getByTestId("bc-live-badge")).toBeVisible();
  await expect(page.getByTestId("bc-title")).toHaveText("e2e 라이브");
  await expect(page.getByRole("heading", { name: /^대기 3건/ })).toBeVisible();

  // 개봉 시작(버튼) → A 개봉 중
  await page.getByRole("button", { name: /개봉 시작/ }).click();
  const opening = page.getByTestId("bc-opening");
  await expect(opening).toContainText(A);
  await expect(opening).toContainText("개봉 시간");
  await expect(waitingNames(page)).toHaveText([C, B]);

  // 단축키 Ctrl+↑: 타이머 +30초 → 남은 시간 카운트다운
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+ArrowUp");
  await expect(opening).toContainText("남은 시간");
  await expect(opening.locator(".num")).toHaveText(/^0:(2\d|30)$/);
  await shot(page, "SA-001-live");

  // 단축키 Ctrl+Enter: 개봉 완료 → 최근 완료에 A, 10초 안 되돌리기
  await page.keyboard.press("Control+Enter");
  await expect(toast(page)).toContainText("개봉을 완료했습니다");
  const done = page.getByTestId("bc-done").locator("tr", { hasText: A });
  await expect(done).toBeVisible();
  await done.getByRole("button", { name: "되돌리기" }).click();
  await expect(opening).toContainText(A);

  // 다시 완료(버튼)
  await page.getByRole("button", { name: /개봉 완료/ }).click();
  await expect(page.getByTestId("bc-opening")).toHaveCount(0);

  // 대기 타이머 설정(창): C에 3분
  const rowC = page.getByTestId("bc-waiting").locator("tr", { hasText: C });
  await rowC.getByRole("button", { name: "타이머" }).click();
  const timer = page.getByRole("dialog", { name: "타이머 설정" });
  await timer.getByRole("button", { name: "3분" }).click();
  await timer.getByRole("button", { name: "저장" }).click();
  await expect(timer).toHaveCount(0);
  await expect(rowC).toContainText("3:00");

  // 대기 취소: 사유가 있어야 한다
  await rowC.getByRole("button", { name: "취소" }).click();
  const cancel = page.getByRole("dialog", { name: "이 주문을 취소하시겠습니까?" });
  await expect(cancel.getByRole("button", { name: "주문대기 취소" })).toBeDisabled();
  await cancel.getByLabel("취소 사유").fill("구매자 요청");
  await cancel.getByRole("button", { name: "주문대기 취소" }).click();
  await expect(cancel).toHaveCount(0);
  await expect(waitingNames(page)).toHaveText([B]);

  // 방송 종료 → 남은 B는 방송 전 대기로
  await page.getByRole("button", { name: "방송 종료" }).click();
  const end = page.getByRole("dialog", { name: "방송을 종료하시겠습니까?" });
  await expect(end).toContainText("남은 대기 1건은 다음 방송으로 넘어갑니다");
  await end.getByRole("button", { name: "방송 종료" }).click();
  await expect(page.getByTestId("bc-live-badge")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /방송 전 대기 1건/ })).toBeVisible();

  // 서버에 남은 상태
  const s = await queueStatuses();
  expect(s[A].status).toBe("DONE");
  expect(s[A].timerSeconds).toBe(30);
  expect(s[C].status).toBe("CANCELLED");
  expect(s[C].cancelReason).toBe("구매자 요청");
  expect(s[C].timerSeconds).toBe(180);
  expect(s[B].status).toBe("WAITING");
  expect(s[B].broadcastSessionId).toBeNull();
});

test("다른 창에서 바꾼 내용이 새로 고침 없이 반영된다(실시간 채널)", async ({ page, context }) => {
  await login(page, "demo-owner@example.com", "/seller/broadcast");
  await expect(page.getByRole("heading", { name: /방송 전 대기 3건/ })).toBeVisible();
  const other = await context.newPage();
  await other.goto("/seller/broadcast");
  await expect(other.getByRole("heading", { name: /방송 전 대기 3건/ })).toBeVisible();

  await page.getByRole("button", { name: "방송 시작" }).click();
  await expect(page.getByTestId("bc-live-badge")).toBeVisible();
  // 15초 확인 주기보다 빨리 반영된다
  await expect(other.getByTestId("bc-live-badge")).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: /개봉 시작/ }).click();
  await expect(other.getByTestId("bc-opening")).toContainText(A, { timeout: 5000 });
  await other.close();
});

test("결과가 불분명한 요청은 성공으로 보이지 않고 서버 상태를 다시 읽는다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/broadcast");
  await expect(page.getByRole("heading", { name: /방송 전 대기 3건/ })).toBeVisible();
  await page.route("**/api/seller/broadcast/start", (r) => r.abort("connectionreset"));
  await page.getByRole("button", { name: "방송 시작" }).click();
  await expect(toast(page)).toContainText("처리 결과를 확인하지 못했습니다");
  await expect(page.getByTestId("bc-live-badge")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /방송 전 대기 3건/ })).toBeVisible();
});

test("방송 진행 권한이 없는 직원: 메뉴가 없고 주소로 들어와도 화면이 없다", async ({ page }) => {
  await login(page, "demo-none@example.com", "/seller/broadcast");
  await expect(page).toHaveURL(/\/seller\/broadcast$/);
  await expect(page.getByText("이 기능은 권한이 필요합니다")).toBeVisible();
  await expect(page.getByText("필요한 권한: 방송 진행")).toBeVisible();
  await expect(page.getByRole("link", { name: "방송 대시보드" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "방송 시작" })).toHaveCount(0);
});

const isQueueGet = (u: URL) => u.pathname === "/api/seller/queue";

// 방송을 시작하고 첫 대기(A)를 개봉 중으로 둔다
async function openFirst(page: Page) {
  await login(page, "demo-owner@example.com", "/seller/broadcast");
  await page.getByRole("button", { name: "방송 시작" }).click();
  await expect(page.getByTestId("bc-live-badge")).toBeVisible();
  await page.getByRole("button", { name: /개봉 시작/ }).click();
  await expect(page.getByTestId("bc-opening")).toContainText(A);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
}

test("변경 뒤 다시 읽기가 끝날 때까지 조작을 막아, 이어서 누른 단축키가 옛 version으로 거부되지 않는다", async ({ page }) => {
  await openFirst(page);
  const complete = page.getByRole("button", { name: /개봉 완료/ });
  // 다시 읽기를 늦춘다: 그동안 버튼이 풀리면 옛 version으로 두 번째 요청이 나가 409가 난다
  await page.route(isQueueGet, async (r) => {
    await new Promise((f) => setTimeout(f, 800));
    await r.continue();
  });
  await page.keyboard.press("Control+ArrowUp");
  await expect(complete).toBeDisabled();
  await expect(complete).toBeEnabled();
  await page.keyboard.press("Control+ArrowUp");
  await expect(complete).toBeDisabled();
  await expect(complete).toBeEnabled();
  await expect(page.getByTestId("bc-opening").locator(".num")).toHaveText(/^(1:00|0:5\d)$/);
  await expect(toast(page)).not.toContainText("다른 화면에서 먼저 바뀌었습니다");
  expect((await queueStatuses())[A].timerSeconds).toBe(60);
});

test("변경 전에 보낸 읽기가 변경 성공 뒤에 도착하면 반영하지 않고, 다시 읽기가 실패하면 낡음 안내를 남긴다", async ({ page }) => {
  await openFirst(page);
  let release!: () => void;
  const held = new Promise<void>((f) => (release = f));
  let n = 0;
  await page.route(isQueueGet, async (r) => {
    n += 1;
    if (n === 1) {
      // 변경 전에 시작된 읽기: 변경 전 상태를 받아 두었다가 변경이 성공한 뒤에 돌려준다
      const res = await r.fetch();
      await held;
      return r.fulfill({ response: res });
    }
    return r.abort("connectionreset");
  });
  const oldRead = page.waitForRequest((q) => isQueueGet(new URL(q.url())));
  await bumpLiveVersion();
  await oldRead;
  const posted = page.waitForResponse((q) => q.url().endsWith("/timer") && q.request().method() === "POST");
  await page.keyboard.press("Control+ArrowUp");
  expect((await posted).status()).toBe(200);
  await expect(page.getByTestId("bc-stale")).toBeVisible();
  release();
  await page.waitForTimeout(500);
  // 늦게 온 옛 응답이 화면을 「최신」으로 덮지 않는다
  await expect(page.getByTestId("bc-stale")).toBeVisible();
  expect((await queueStatuses())[A].timerSeconds).toBe(30);
});

test("되돌리기는 지금 방송에서 완료한 주문에만 보인다(방송을 바꾼 뒤 10초 안이어도 이전 방송 주문은 없음)", async ({ page }) => {
  await openFirst(page);
  await page.keyboard.press("Control+Enter");
  const done = page.getByTestId("bc-done").locator("tr", { hasText: A });
  await expect(done.getByRole("button", { name: "되돌리기" })).toBeVisible();
  await page.getByRole("button", { name: "방송 종료" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "방송 종료" }).click();
  await expect(page.getByTestId("bc-live-badge")).toHaveCount(0);
  await page.getByRole("button", { name: "방송 시작" }).click();
  await expect(page.getByTestId("bc-live-badge")).toBeVisible();
  await expect(done).toBeVisible();
  await expect(done.getByRole("button", { name: "되돌리기" })).toHaveCount(0);
});

test("변경 뒤 다시 읽기가 실패하면 변경 조작을 모두 끄고, 다시 불러오기가 성공해야 다시 켠다", async ({ page }) => {
  await openFirst(page);
  const complete = page.getByRole("button", { name: /개봉 완료/ });
  await page.route(isQueueGet, (r) => r.abort("connectionreset"));
  await page.keyboard.press("Control+ArrowUp");
  await expect(page.getByTestId("bc-stale")).toContainText("다시 불러오기 전까지 변경할 수 없습니다");
  // 옛 version을 가진 화면에서는 버튼·단축키·창 확인이 모두 막힌다
  await expect(complete).toBeDisabled();
  await expect(page.getByRole("button", { name: "방송 종료" })).toBeDisabled();
  await page.keyboard.press("Control+ArrowUp");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(300);
  const s = await queueStatuses();
  expect(s[A].status).toBe("OPENING");
  expect(s[A].timerSeconds).toBe(30);
  // 다시 불러오기가 성공하면 최신 상태로 켜진다
  await page.unroute(isQueueGet);
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(page.getByTestId("bc-stale")).toHaveCount(0);
  await expect(complete).toBeEnabled();
  await expect(page.getByTestId("bc-opening").locator(".num")).toHaveText(/^0:(2\d|30)$/);
  await page.keyboard.press("Control+ArrowUp");
  await expect(toast(page)).toContainText("타이머를 1:00로 정했습니다");
  expect((await queueStatuses())[A].timerSeconds).toBe(60);
});

test("거부(409)된 변경도 그 전에 시작된 읽기를 무효로 해, 늦게 온 옛 읽기가 잠금을 풀지 않는다", async ({ page }) => {
  await openFirst(page);
  let release!: () => void;
  const held = new Promise<void>((f) => (release = f));
  let n = 0;
  await page.route(isQueueGet, async (r) => {
    n += 1;
    if (n === 1) {
      const res = await r.fetch();
      await held;
      return r.fulfill({ response: res });
    }
    return r.abort("connectionreset");
  });
  // 다른 화면이 먼저 바꾼 것처럼 서버가 409로 거부한다
  await page.route("**/api/seller/queue/*/timer", (r) => r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "conflict" }) }));
  const oldRead = page.waitForRequest((q) => isQueueGet(new URL(q.url())));
  await bumpLiveVersion();
  await oldRead;
  await page.keyboard.press("Control+ArrowUp");
  await expect(toast(page)).toContainText("다른 화면에서 먼저 바뀌었습니다");
  await expect(page.getByTestId("bc-stale")).toBeVisible();
  release();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("bc-stale")).toBeVisible();
  await expect(page.getByRole("button", { name: /개봉 완료/ })).toBeDisabled();
});

test("종료 확인 창이 열린 사이 다른 화면이 방송을 바꾸면 창을 닫고, 새 방송은 끝나지 않는다", async ({ page, context }) => {
  await login(page, "demo-owner@example.com", "/seller/broadcast");
  await page.getByLabel("방송 제목").fill("방송 A");
  await page.getByRole("button", { name: "방송 시작" }).click();
  await expect(page.getByTestId("bc-title")).toHaveText("방송 A");
  await page.getByRole("button", { name: "방송 종료" }).click();
  const dialog = page.getByRole("dialog", { name: "방송을 종료하시겠습니까?" });
  await expect(dialog).toBeVisible();
  // 다른 창: A를 끝내고 B를 시작
  const other = await context.newPage();
  await other.goto("/seller/broadcast");
  await other.getByRole("button", { name: "방송 종료" }).click();
  await other.getByRole("dialog").getByRole("button", { name: "방송 종료" }).click();
  await other.getByLabel("방송 제목").fill("방송 B");
  await other.getByRole("button", { name: "방송 시작" }).click();
  await expect(other.getByTestId("bc-title")).toHaveText("방송 B");
  // 처음 창: 확인 창이 닫히고 B가 보인다(B를 끌 수 있는 확인 버튼이 남지 않음)
  await page.bringToFront();
  await expect(page.getByTestId("bc-title")).toHaveText("방송 B", { timeout: 5000 });
  await expect(dialog).toHaveCount(0);
  await expect(toast(page)).toContainText("다른 화면에서 방송이 바뀌었습니다");
  await other.reload();
  await expect(other.getByTestId("bc-title")).toHaveText("방송 B");
  await other.close();
});

test("보던 중 권한·이용 상태가 끝나면(403) 옛 내용과 버튼을 지우고 권한 안내로 바꾼다", async ({ page }) => {
  await openFirst(page);
  await page.route(isQueueGet, (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }));
  await bumpLiveVersion();
  await expect(page.getByText("이 기능은 권한이 필요합니다")).toBeVisible();
  await expect(page.getByTestId("bc-opening")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /개봉 완료/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "방송 종료" })).toHaveCount(0);
});

test("Ctrl+Enter를 누른 채 있어도(자동 반복) 완료는 한 번만, 다음 주문이 저절로 개봉되지 않는다", async ({ page }) => {
  await openFirst(page);
  await page.keyboard.down("Control");
  await page.keyboard.down("Enter");
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(150);
    await page.keyboard.down("Enter"); // 이미 눌린 키: repeat=true로 전달됨
  }
  await page.keyboard.up("Enter");
  await page.keyboard.up("Control");
  await expect(toast(page)).toContainText("개봉을 완료했습니다");
  await expect(page.getByTestId("bc-opening")).toHaveCount(0);
  const s = await queueStatuses();
  expect(s[A].status).toBe("DONE");
  expect(s[B].status).toBe("WAITING");
  expect(s[C].status).toBe("WAITING");
});

test("PC 시계가 틀려도(1시간 빠름) 방금 완료한 주문의 되돌리기가 보이고 동작한다", async ({ page }) => {
  await page.clock.setSystemTime(new Date(Date.now() + 3600_000));
  await openFirst(page);
  await page.keyboard.press("Control+Enter");
  const done = page.getByTestId("bc-done").locator("tr", { hasText: A });
  await done.getByRole("button", { name: "되돌리기" }).click();
  await expect(page.getByTestId("bc-opening")).toContainText(A);
  expect((await queueStatuses())[A].status).toBe("OPENING");
});
