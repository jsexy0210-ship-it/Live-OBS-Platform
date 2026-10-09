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
  for (const width of [1440, 1024, 390]) {
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
  await page.waitForURL((url) => url.pathname === next);
}

const waitingNames = (page: Page) => page.getByTestId("bc-waiting").locator("tr .t-l1");
const toast = (page: Page) => page.getByRole("status").filter({ has: page.locator(".toast") });

test("오버레이 전용 역할도 단일 홈에서 기존 정보와 방송을 보며 스토어 업무를 열지 않는다", async ({ page }) => {
  await login(page, "demo-overlay-owner@example.com", "/seller");
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.getByRole("heading", { level: 1, name: "홈", exact: true })).toHaveCount(1);
  await expect(page.getByTestId("oh-tiles")).toBeVisible();
  await expect(page.getByTestId("oh-upgrade")).toBeVisible();
  await expect(page.getByTestId("home-tasks")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "유튜브 실시간 화면", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "방송 대시보드", exact: true })).toHaveCount(0);
  const denied = await page.request.get("/api/seller/products");
  expect(denied.status()).toBe(403);
  const waiting = page.getByRole("region", { name: "방송 전 대기 0건", exact: true });
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText("대기 중인 주문이 없습니다");
  await expect(page.getByTestId("bc-waiting")).toHaveCount(0);
  await shot(page, "sa002-unified-home-overlay-owner");
});

test("두 기존 홈 주소는 단일 홈으로 이동하고 유튜브 패널은 세 폭에서 현재 방송만 표시한다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller");
  for (const path of ["/seller/broadcast", "/seller/home-overlay"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/seller$/);
    await expect(page.getByRole("heading", { level: 1, name: "홈", exact: true })).toHaveCount(1);
  }
  await expect(page.getByRole("link", { name: "방송 대시보드", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("home-tasks")).toBeVisible();
  const snapshotResponse = await page.request.get("/api/seller/queue");
  expect(snapshotResponse.status()).toBe(200);
  const snapshot = await snapshotResponse.json();
  await page.route("**/api/seller/queue", async (route) => route.fulfill({ json: { ...snapshot, broadcast: { id: "synthetic-current", title: "합성 방송", startedAt: "2026-10-09T00:00:00Z" } } }));
  await page.route("**/api/seller/youtube", async (route) => route.fulfill({ json: { configured: true, live: { videoId: "synthetic01", title: "합성 방송", status: "live", broadcastSessionId: "synthetic-current", chatEnabled: false }, chatNotice: "합성 UI 검수" } }));
  // 외부 영상·실방송을 호출하지 않는다. iframe의 배치·선택 계약만 합성으로 검증한다.
  await page.route("https://www.youtube.com/embed/**", async (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>합성 iframe 배치 검수</title>" }));
  await page.reload();
  const player = page.getByTestId("bc-youtube-player");
  await expect(player).toHaveAttribute("src", "https://www.youtube.com/embed/synthetic01?playsinline=1&controls=1");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const box = await player.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(200);
    expect(box!.height).toBeGreaterThanOrEqual(200);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `tests/e2e/screenshots/sa002-unified-home-synthetic-${width}.png`, fullPage: true });
  }
  await page.route("**/api/seller/youtube", async (route) => route.fulfill({ json: { configured: true, live: { videoId: "synthetic01", title: "다른 방송", status: "live", broadcastSessionId: "other", chatEnabled: false }, chatNotice: "합성 UI 검수" } }));
  await page.reload();
  await expect(player).toHaveCount(0);
  await expect(page.getByTestId("bc-youtube-notice")).toContainText("현재 방송과 연결된");
  await page.route("**/api/seller/youtube", async (route) => route.fulfill({ json: { configured: true, live: null, chatNotice: "합성 미연결 검수" } }));
  await page.reload();
  await expect(player).toHaveCount(0);
  await expect(page.getByTestId("bc-youtube-notice")).toContainText("연결된 유튜브 방송이 없습니다");
  await shot(page, "sa002-unified-home-youtube-empty");
  await page.route("**/api/seller/youtube", async (route) => route.fulfill({ json: { configured: true, live: { videoId: "synthetic01", title: "예정된 합성 방송", status: "upcoming", broadcastSessionId: "synthetic-current", chatEnabled: false }, chatNotice: "합성 예정 검수" } }));
  await page.reload();
  await expect(player).toHaveCount(0);
  await expect(page.getByTestId("bc-youtube-notice")).toContainText("예정된 유튜브 방송");
  await shot(page, "sa002-unified-home-youtube-upcoming");
  await page.route("**/api/seller/youtube", async (route) => route.fulfill({ status: 503, json: { error: "synthetic_unavailable" } }));
  await page.reload();
  await expect(player).toHaveCount(0);
  await expect(page.getByTestId("bc-youtube-notice")).toContainText("유튜브 연결을 불러오지 못했습니다");
  await shot(page, "sa002-unified-home-youtube-error");
});

test("채팅이 꺼지고 큐 버전이 같아도 유튜브 연결과 해제가 새로 고침 없이 반영된다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller");
  const snapshotResponse = await page.request.get("/api/seller/queue");
  expect(snapshotResponse.status()).toBe(200);
  const snapshot = await snapshotResponse.json();
  let connected = false;
  let queueReads = 0;
  await page.route("**/api/seller/queue", async (route) => {
    queueReads++;
    await route.fulfill({ json: { ...snapshot, broadcast: { id: "synthetic-current", title: "합성 방송", startedAt: "2026-10-09T00:00:00Z" } } });
  });
  await page.route("**/api/seller/queue/version", async (route) => route.fulfill({ json: { version: snapshot.version } }));
  await page.route("**/api/seller/youtube", async (route) => route.fulfill({ json: {
    configured: true,
    live: connected ? { videoId: "synthetic01", title: "합성 방송", status: "live", broadcastSessionId: "synthetic-current", chatEnabled: false } : null,
    chatNotice: "합성 연결 변경 검수",
  } }));
  await page.route("https://www.youtube.com/embed/**", async (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>합성 연결 변경 검수</title>" }));
  await page.clock.install();
  await page.reload();
  const player = page.getByTestId("bc-youtube-player");
  await expect(page.getByTestId("bc-youtube-notice")).toContainText("연결된 유튜브 방송이 없습니다");
  const initialQueueReads = queueReads;
  connected = true;
  await page.clock.fastForward(30_000);
  await expect(player).toHaveAttribute("src", "https://www.youtube.com/embed/synthetic01?playsinline=1&controls=1");
  expect(queueReads).toBe(initialQueueReads);
  connected = false;
  await page.clock.fastForward(30_000);
  await expect(player).toHaveCount(0);
  await expect(page.getByTestId("bc-youtube-notice")).toContainText("연결된 유튜브 방송이 없습니다");
  expect(queueReads).toBe(initialQueueReads);
});

test("대표자: 방송 시작부터 개봉·타이머·완료·되돌리기·취소·종료까지 실제로 처리된다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/products");
  await expect(page).toHaveURL(/\/seller\/products$/);
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "홈", exact: true }).click();
  await expect(page).toHaveURL(/\/seller$/);

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
  const homeBroadcast = page.getByTestId("home-broadcasts").locator("tbody tr", { hasText: "e2e 라이브" });
  await expect(homeBroadcast).toContainText("방송 중");
  await expect(page.getByTestId("bc-summary")).toContainText("지금 방송");
  await expect(page.getByTestId("bc-summary")).toContainText("완료 / 뺀 주문");
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
  const timer = page.getByRole("dialog", { name: "개봉 시간 알림을 정하시겠습니까?" });
  await timer.getByRole("button", { name: "3분" }).click();
  await timer.getByRole("button", { name: "이 시간으로 정하기" }).click();
  await expect(timer).toHaveCount(0);
  await expect(rowC).toContainText("3:00");

  // 대기 취소: 사유가 있어야 한다
  await rowC.getByRole("button", { name: "주문대기에서 빼기" }).click();
  const cancel = page.getByRole("dialog", { name: "이 주문을 주문대기에서 빼시겠습니까?" });
  await expect(cancel.getByRole("button", { name: "주문대기에서 빼기" })).toBeDisabled();
  await cancel.getByLabel("빼는 이유").fill("구매자 요청");
  await cancel.getByRole("button", { name: "주문대기에서 빼기" }).click();
  await expect(cancel).toHaveCount(0);
  await expect(waitingNames(page)).toHaveText([B]);

  // 방송 종료 → 남은 B는 방송 전 대기로
  await page.getByRole("button", { name: "방송 끝내기" }).click();
  const end = page.getByRole("dialog", { name: "방송을 끝내시겠습니까?" });
  await expect(end).toContainText("남은 대기 1건은 다음 방송으로 넘어갑니다");
  await end.getByRole("button", { name: "방송 끝내기" }).click();
  await expect(page.getByTestId("bc-live-badge")).toHaveCount(0);
  await expect(homeBroadcast).toBeVisible();
  await expect(homeBroadcast.locator(".home-live")).toHaveCount(0);
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
  await login(page, "demo-owner@example.com", "/seller");
  await expect(page.getByRole("heading", { name: /방송 전 대기 3건/ })).toBeVisible();
  const other = await context.newPage();
  await other.goto("/seller");
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
  await login(page, "demo-owner@example.com", "/seller");
  await expect(page.getByRole("heading", { name: /방송 전 대기 3건/ })).toBeVisible();
  await page.route("**/api/seller/broadcast/start", (r) => r.abort("connectionreset"));
  await page.getByRole("button", { name: "방송 시작" }).click();
  await expect(toast(page)).toContainText("처리 결과를 확인하지 못했습니다");
  await expect(page.getByTestId("bc-live-badge")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /방송 전 대기 3건/ })).toBeVisible();
});

test("방송 진행 권한이 없는 직원: 메뉴가 없고 주소로 들어와도 화면이 없다", async ({ page }) => {
  await login(page, "demo-none@example.com", "/seller");
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.getByRole("heading", { level: 1, name: "홈", exact: true })).toBeVisible();
  await expect(page.getByTestId("bc-waiting")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "방송 대시보드" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "방송 시작" })).toHaveCount(0);
  await shot(page, "sa002-unified-home-staff-no-broadcast");
});

const isQueueGet = (u: URL) => u.pathname === "/api/seller/queue";

// 방송을 시작하고 첫 대기(A)를 개봉 중으로 둔다
async function openFirst(page: Page) {
  await login(page, "demo-owner@example.com", "/seller");
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
  await page.getByRole("button", { name: "방송 끝내기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "방송 끝내기" }).click();
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
  await expect(page.getByRole("button", { name: "방송 끝내기" })).toBeDisabled();
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

test("종료 확인 창이 열린 사이 다른 화면이 방송을 바꾸면 끝내지 않고 창 안에 안내하며, 새 방송은 끝나지 않는다", async ({ page, context }) => {
  await login(page, "demo-owner@example.com", "/seller");
  await page.getByLabel("방송 제목").fill("방송 A");
  await page.getByRole("button", { name: "방송 시작" }).click();
  await expect(page.getByTestId("bc-title")).toHaveText("방송 A");
  await page.getByRole("button", { name: "방송 끝내기" }).click();
  const dialog = page.getByRole("dialog", { name: "방송을 끝내시겠습니까?" });
  await expect(dialog).toBeVisible();
  // 다른 창: A를 끝내고 B를 시작
  const other = await context.newPage();
  await other.goto("/seller");
  await other.getByRole("button", { name: "방송 끝내기" }).click();
  await other.getByRole("dialog").getByRole("button", { name: "방송 끝내기" }).click();
  await other.getByLabel("방송 제목").fill("방송 B");
  await other.getByRole("button", { name: "방송 시작" }).click();
  await expect(other.getByTestId("bc-title")).toHaveText("방송 B");
  // 처음 창: 확인 창이 열려 있어도, 「방송 끝내기」를 누르면 지금 방송(B)이 그 방송이 아니라서 보내지 않고 창 안에 안내한다
  await page.bringToFront();
  await dialog.getByRole("button", { name: "방송 끝내기" }).click();
  await expect(dialog).toContainText("다른 화면에서 방송이 바뀌었습니다", { timeout: 5000 });
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("bc-title")).toHaveText("방송 B", { timeout: 5000 });
  await other.reload();
  await expect(other.getByTestId("bc-title")).toHaveText("방송 B");
  await other.close();
});

test("보던 중 권한·이용 상태가 끝나면(403) 옛 내용과 버튼을 지우고 권한 안내로 바꾼다", async ({ page }) => {
  await openFirst(page);
  await page.route(isQueueGet, (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }));
  await bumpLiveVersion();
  await expect(page.getByText("이 계정은 이 일을 할 수 없습니다")).toBeVisible();
  await expect(page.getByTestId("bc-opening")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /개봉 완료/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "방송 끝내기" })).toHaveCount(0);
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

// 휴대폰(390폭): 대기 표가 카드(DS-TABLE-CARD, 768px 미만)로 바뀐다. 가로로 밀리지 않고, 한 행 = 카드 한 장, 관리 버튼은 높이 44px 이상이 화면 안에 모두 보인다.
test("390폭: 대기 표가 모바일 카드로 바뀌고 가로 스크롤 없이 버튼이 44px 이상으로 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "demo-owner@example.com", "/seller");
  await expect(waitingNames(page)).toHaveText([A, B, C]);
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/SA-001-390.png", fullPage: true });
  // 화면 전체는 가로로 밀리지 않는다
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const section = page.locator("section[aria-labelledby=bc-waiting-h]");
  const wrap = section.locator(".au-lt-wrap");
  // 표 안에서도 가로로 밀 필요가 없다(카드는 한 칸 폭)
  const m = await wrap.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  expect(m.scroll).toBeLessThanOrEqual(m.client + 1);
  // 머리글 줄은 숨고, 칸마다 「라벨: 값」이 보인다(순서·주문 시각·금액·타이머)
  await expect(section.locator("thead")).toBeHidden();
  const firstCard = section.locator("tbody tr").first();
  for (const label of ["순서", "주문 시각", "금액", "타이머"]) {
    const before = await firstCard.locator(`td[data-label="${label}"]`).evaluate((el) => getComputedStyle(el, "::before").content);
    expect(before).toContain(label);
  }
  // 관리 버튼 4개 모두 화면 안, 높이 44px 이상
  for (const name of [`${A} 위로`, `${A} 아래로`, "타이머 정하기", "주문대기에서 빼기"]) {
    const btn = firstCard.getByRole("button", { name: name.includes(A) ? name : new RegExp(`^${name}$`) });
    const box = await btn.boundingBox();
    expect(box, name).not.toBeNull();
    expect(box!.height, name).toBeGreaterThanOrEqual(43.5);
    expect(box!.x, name).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, name).toBeLessThanOrEqual(390 + 1);
  }
  // 카드는 세 장(행마다 한 장)
  await expect(section.locator("tbody tr")).toHaveCount(3);
  await page.screenshot({ path: "tests/e2e/screenshots/SA-001-390-scrolled.png", fullPage: true });
});

// 문구 교체(쉬운 말)로 대기 표 「조작」 열 폭을 240→360px, 좁은 화면(≤1280px) 표 최소 폭을 880px로 넓혔고, 금액 열(100px)을 더하며 980px로 다시 넓혔다(의도한 차이).
// 1440·1024·390에서 대기 표 버튼이 잘리지 않고, 좁은 폭에서는 카드 안에서만 가로로 스크롤되는지 보고 캡처를 남긴다(E2E_SCREENSHOTS=1).
test("방송 대시보드 대기 표: 1440·1024·390폭에서 조작 버튼이 잘리지 않는다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller");
  await expect(waitingNames(page)).toHaveText([A, B, C]);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.waitForTimeout(600); // 메뉴 서랍이 접히는 전환이 끝난 뒤 잰다
    // 화면 전체는 가로로 밀리지 않는다: 문서 너비 = 화면 너비, 가로 스크롤 위치 0, 본문이 왼쪽으로 나가지 않음(좁은 폭의 메뉴 서랍은 화면 밖에 접혀 있다)
    const doc = () =>
      page.evaluate(() => {
        const de = document.documentElement;
        const lnb = document.querySelector('aside[aria-label="파트너스 메뉴"]')?.getBoundingClientRect();
        return { sw: de.scrollWidth, cw: de.clientWidth, sx: window.scrollX, main: document.querySelector("main")!.getBoundingClientRect().left, h1: document.querySelector("h1")!.getBoundingClientRect().left, lnbRight: lnb ? lnb.right : null, narrow: window.innerWidth < 1024 };
      });
    const before = await doc();
    expect(before.sw).toBe(width);
    expect(before.cw).toBe(width);
    expect(before.sx).toBe(0);
    expect(before.main).toBeGreaterThanOrEqual(0);
    expect(before.h1).toBeGreaterThanOrEqual(0);
    if (before.narrow && before.lnbRight !== null) expect(before.lnbRight).toBeLessThanOrEqual(0);
    const wrap = page.locator("section[aria-labelledby=bc-waiting-h] .au-lt-wrap");
    const m = await wrap.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    // 넓은 폭에서는 표 전체가 보이고, 1024폭은 카드 안에서만 스크롤되며, 768px 미만은 모바일 카드라 스크롤이 필요 없다
    if (width >= 1440 || width < 768) expect(m.scroll).toBeLessThanOrEqual(m.client + 1);
    else expect(m.scroll).toBeGreaterThan(m.client);
    if (width < 768) {
      if (SHOTS) await page.screenshot({ path: `tests/e2e/screenshots/SA-001-plain-${width}.png`, fullPage: true });
      continue;
    }
    // 금액 열: 내부 주문 항목은 상품 합계(원)가 보인다
    await expect(page.locator("section[aria-labelledby=bc-waiting-h] th", { hasText: "금액" })).toBeVisible();
    await expect(page.getByTestId("bc-amount").first()).toHaveText(/^[\d,]+원$/);
    // 모든 폭에서 구매자·상품 머리글이 읽히고, 끝까지 밀면 마지막 버튼이 영역 안에 보인다
    const head = await page.locator("section[aria-labelledby=bc-waiting-h] th", { hasText: "구매자 · 상품" }).boundingBox();
    expect(head!.width).toBeGreaterThanOrEqual(120);
    await wrap.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    const box = await wrap.boundingBox();
    const btn = await page.getByRole("button", { name: `${A} 아래로` }).boundingBox();
    expect(btn!.x).toBeGreaterThanOrEqual(box!.x);
    expect(btn!.x + btn!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
    await wrap.evaluate((el) => (el.scrollLeft = 0));
    // 표를 끝까지 밀었다 돌아온 뒤에도 화면 전체는 그대로다
    expect(await doc()).toEqual(before);
    if (SHOTS) await page.screenshot({ path: `tests/e2e/screenshots/SA-001-plain-${width}.png`, fullPage: true });
  }
});

// 공용 확인 창(방송 종료)이 떠 있는 동안에는 단축키로 개봉 완료가 되지 않고, 1440·1024·390폭에서 창이 화면 안에 들어온다
test("방송 종료 확인 창: 떠 있는 동안 Ctrl+Enter가 먹히지 않고, 폭마다 창이 화면 안에 보인다", async ({ page }) => {
  await openFirst(page);
  await page.getByRole("button", { name: "방송 끝내기" }).click();
  const dlg = page.getByRole("dialog", { name: "방송을 끝내시겠습니까?" });
  await expect(dlg).toBeVisible();
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(400);
  await expect(page.getByTestId("bc-opening")).toContainText(A);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.waitForTimeout(600);
    const b = await dlg.boundingBox();
    expect(b!.x).toBeGreaterThanOrEqual(0);
    expect(b!.x + b!.width).toBeLessThanOrEqual(width + 1);
    if (SHOTS) await page.screenshot({ path: `tests/e2e/screenshots/SA-001-end-confirm-${width}.png` });
  }
  await dlg.getByRole("button", { name: "취소" }).click();
  await expect(dlg).toHaveCount(0);
});
