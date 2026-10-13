import { expect, test } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// OV-001 쇼핑몰 정보·신규 주문 알림 위젯: 공개 state의 shop·orderEvents(기반 계약)를 모의 응답으로 흘려 화면 동작을 확인한다.
// - 쇼핑몰 정보: 쇼핑몰 주소가 보인다.
// - 신규 주문 알림: 처음 읽을 때 이미 있던 주문은 띄우지 않고, 그 뒤 version이 바뀌어 새로 온 주문만 종류(VIP)에 맞는 위젯에 durationSec 동안 보였다가 사라진다.
const box = { x: 4, y: 10, w: 90, h: 6, z: 1, visible: true };
const widgets = [
  { id: "shop", type: "SHOP_INFO", ...box, props: {} },
  { id: "alert_first", type: "NEW_ORDER_ALERT", ...box, y: 20, z: 9, props: { variant: "first", durationSec: 3 } },
  { id: "alert_vip", type: "NEW_ORDER_ALERT", ...box, y: 30, z: 9, props: { variant: "vip", durationSec: 3 } },
];
const ev = (id: string, kind: string, nickname: string) => ({ id, kind, nickname, productLabel: "프리미엄 박스", quantity: 2, moreItems: 1, occurredAt: new Date().toISOString() });

test("쇼핑몰 주소가 보이고, 새로 온 VIP 주문만 VIP 알림 위젯에 잠깐 뜬다", async ({ page }) => {
  test.setTimeout(60_000);
  let phase = 0;
  await page.route("**/api/overlay/*/layout*", (r) => r.fulfill({ json: { aspect: "9x16", version: 1, widgets } }));
  await page.route("**/api/overlay/*/stream", (r) => r.abort());
  await page.route("**/api/overlay/*/version", (r) => r.fulfill({ json: { version: phase + 1 } }));
  await page.route("**/api/overlay/*/state", (r) =>
    r.fulfill({
      json: {
        version: phase + 1,
        live: true,
        opening: null,
        waiting: [],
        hits: [],
        shop: { name: "카드숍 별빛", url: "https://shop.test/shop/starlight" },
        orderEvents: phase === 0 ? [ev("old", "FIRST", "먼저온손님")] : [ev("new", "VIP", "별빛하늘"), ev("old", "FIRST", "먼저온손님")],
      },
    }),
  );
  await page.setViewportSize({ width: 1080, height: 1920 });
  await page.goto("/overlay/mock-token");
  await expect(page.locator('[data-widget="SHOP_INFO"]')).toContainText("shop.test/shop/starlight");
  // 처음부터 있던 주문은 띄우지 않는다
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-widget="NEW_ORDER_ALERT"]')).toHaveCount(0);

  phase = 1; // 새 주문이 들어왔고 version이 올랐다(15초 확인에서 읽는다)
  const alert = page.locator('[data-widget="NEW_ORDER_ALERT"]');
  await expect(alert).toHaveCount(1, { timeout: 25_000 });
  await expect(alert).toContainText("VIP");
  await expect(alert).toContainText("별빛하늘님이 프리미엄 박스 외 1건 2개를 주문했어요");
  await expect(alert).toHaveCSS("top", `${1920 * 0.3}px`);
  await expect(alert).toHaveCount(0, { timeout: 8000 });
});

// OV-003 HIT 카드 강조: 처음부터 있던 카드는 그대로, 새로 들어온 카드만 잠깐 강조한 뒤 평소 모양으로 돌아온다.
test("새로 들어온 HIT 카드만 잠깐 강조된다", async ({ page }) => {
  test.setTimeout(60_000);
  let phase = 0;
  const hof = [{ id: "hof", type: "HALL_OF_FAME", ...box, h: 30, props: { rows: 5 } }];
  const hit = (id: string, cardName: string) => ({ id, cardName, nickname: "별빛하늘" });
  await page.route("**/api/overlay/*/layout*", (r) => r.fulfill({ json: { aspect: "9x16", version: 1, widgets: hof } }));
  await page.route("**/api/overlay/*/stream", (r) => r.abort());
  await page.route("**/api/overlay/*/version", (r) => r.fulfill({ json: { version: phase + 1 } }));
  await page.route("**/api/overlay/*/state", (r) =>
    r.fulfill({ json: { version: phase + 1, live: true, opening: null, waiting: [], hits: phase === 0 ? [hit("a", "옛 카드")] : [hit("b", "새 카드"), hit("a", "옛 카드")], orderEvents: [] } }),
  );
  await page.setViewportSize({ width: 1080, height: 1920 });
  await page.goto("/overlay/mock-token");
  await expect(page.locator('[data-widget="HALL_OF_FAME"]')).toContainText("옛 카드");
  await expect(page.locator(".ow-hit-new")).toHaveCount(0);

  phase = 1;
  const fresh = page.locator(".ow-hit-new");
  await expect(fresh).toHaveCount(1, { timeout: 25_000 });
  await expect(fresh).toContainText("새 카드");
  await expect(fresh).not.toContainText("옛 카드");
  await expect(page.locator(".ow-hit-new")).toHaveCount(0, { timeout: 12_000 });
});

// OV-007 이벤트 할인 카드 · OV-004 구매 랭킹: 공개 state의 eventCard·purchaseRanking(기반 계약, #609)을 모의 응답으로 흘려 확인한다.
// 값이 있으면 카드(상품·할인가·정가·남은 시간)와 랭킹(rows만큼 위에서, 같은 수량은 같은 순위)이 보이고, 없으면(null·빈 배열) 위젯을 그리지 않는다.
test("이벤트 할인 카드와 구매 랭킹이 보이고, 값이 없으면 사라진다", async ({ page }) => {
  test.setTimeout(60_000);
  let phase = 0;
  const wd = [
    { id: "ev", type: "EVENT_CARD", ...box, y: 10, h: 12, props: {} },
    { id: "rk", type: "PURCHASE_RANKING", ...box, y: 30, h: 20, props: { rows: 3 } },
  ];
  const clockTime = Date.now();
  const eventCard = { productName: "프리미엄 박스", price: 20000, discountedPrice: 15000, discountRate: 25, endsAt: new Date(clockTime + 120_000).toISOString(), remainingSeconds: 120, badge: "오늘 마감", remainingLabel: "2분 남았어요", moreCount: 2 };
  let serverElapsedMs = 0;
  const ranking = [
    { rank: 1, nickname: "별빛하늘", quantity: 5 },
    { rank: 2, nickname: "달콤곰", quantity: 3 },
    { rank: 2, nickname: "민트초코", quantity: 3 },
    { rank: 4, nickname: "하루", quantity: 1 },
  ];
  await page.route("**/api/overlay/*/layout*", (r) => {
    const aspect = new URL(r.request().url()).searchParams.get("aspect") ?? "9x16";
    return r.fulfill({ json: { aspect, version: 1, widgets: wd.map((w) => w.type === "EVENT_CARD" ? { ...w, h: aspect === "9x16" ? 18 : 14 } : w) } });
  });
  await page.route("**/api/overlay/*/stream", (r) => r.abort());
  await page.route("**/api/overlay/*/version", (r) => r.fulfill({ json: { version: phase + 1 } }));
  await page.route("**/api/overlay/*/state", (r) =>
    r.fulfill({ json: { version: phase + 1, live: true, opening: null, waiting: [], hits: [], orderEvents: [], eventCard: phase === 0 ? { ...eventCard, remainingSeconds: Math.max(0, eventCard.remainingSeconds - Math.floor(serverElapsedMs / 1000)) } : null, purchaseRanking: phase === 0 ? ranking : [] } }),
  );
  await page.setViewportSize({ width: 1080, height: 1920 });
  await page.clock.pauseAt(new Date(clockTime));
  await page.goto("/overlay/mock-token");

  const ev = page.locator('[data-widget="EVENT_CARD"]');
  await expect(ev).toContainText("프리미엄 박스");
  await expect(ev).toContainText("15,000원");
  await expect(ev).toContainText("20,000원");
  await expect(ev).toContainText("25%");
  await expect(ev).toContainText("곧 끝나요");
  await expect(ev).toContainText("남았어요");
  await expect(ev.locator(".ow-ev-timer")).toHaveText("0:02:00");
  await expect(ev.locator(".ow-ev-rate")).toHaveCSS("font-size", "56px");
  expect(await ev.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
  await page.clock.fastForward(1_000);
  await expect(ev.locator(".ow-ev-timer")).toHaveText("0:01:59");
  serverElapsedMs = 1_000;
  // 랭킹: rows=3만큼 위에서, 같은 수량은 같은 순위(1·2·2), 4위는 잘린다
  const rk = page.locator('[data-widget="PURCHASE_RANKING"]');
  await expect(rk.locator("li")).toHaveCount(3);
  await expect(rk.locator("li").nth(1)).toContainText("달콤곰");
  await expect(rk.locator("li").nth(2)).toContainText("민트초코");
  await expect(rk.locator("li .ow-no")).toHaveText(["1", "2", "2"]);
  await expect(rk).not.toContainText("하루");

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/overlay/mock-token?ratio=16x9");
  const horizontal = page.locator('[data-widget="EVENT_CARD"]');
  await expect(horizontal.locator(".ow-ev-timer")).toBeVisible();
  await expect(horizontal).toHaveCSS("flex-direction", "row");
  await expect(horizontal.locator(".ow-ev-name")).toHaveCSS("font-size", "22px");
  await expect(horizontal.locator(".ow-ev-badge")).toHaveCSS("display", "none");

  await page.clock.fastForward(119_000);
  await expect(horizontal.locator(".ow-ev-rate")).toHaveCount(0);
  await expect(horizontal.locator(".ow-ev-now")).toHaveText("20,000원");
  await expect(horizontal.locator(".ow-ev-timer")).toHaveCount(0);
  phase = 1; // 이벤트 종료 상태는 15초 확인 주기에 서버에서 반영된다
  await page.clock.fastForward(15_000);
  await expect(ev).toHaveCount(0, { timeout: 25_000 });
  await expect(rk).toHaveCount(0);
});

test("이벤트 잔여 시간은 서버 기준이고 KST 자정 종료일을 마지막 날짜로 표시한다", async ({ page }) => {
  const endAt = "2026-10-11T15:00:00.000Z"; // KST 10월 12일 00:00, 유효 구간 마지막 날짜는 10월 11일
  const eventCard = { productName: "프리미엄 박스", price: 20000, discountedPrice: 15000, discountRate: 25, endsAt: endAt, remainingSeconds: 18_000, badge: "오늘 마감", remainingLabel: null, moreCount: 0 };
  const widget = { id: "ev", type: "EVENT_CARD", x: 3, y: 32, w: 94, h: 18, z: 1, visible: true, props: {} };
  await page.route("**/api/overlay/*/layout*", (r) => r.fulfill({ json: { aspect: "9x16", version: 1, widgets: [widget] } }));
  await page.route("**/api/overlay/*/stream", (r) => r.abort());
  await page.route("**/api/overlay/*/version", (r) => r.fulfill({ json: { version: 1 } }));
  await page.route("**/api/overlay/*/state", (r) => r.fulfill({ json: { version: 1, live: false, opening: null, waiting: [], hits: [], orderEvents: [], eventCard } }));
  await page.clock.pauseAt(new Date("2026-10-11T10:05:00.000Z")); // 클라이언트 시계는 서버 기준보다 5분 빠르다
  await page.goto("/overlay/mock-token");

  const card = page.locator('[data-widget="EVENT_CARD"]');
  await expect(card.locator(".ow-ev-timer")).toHaveText("5:00:00");
  await expect(card.locator(".ow-ev-badge")).toHaveText("오늘 마감");
  await expect(card.locator(".ow-ev-remaining")).toHaveText("2026.10.11 23:59까지");

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(card.locator(".ow-ev-timer")).toHaveText("5:00:00");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(tmpdir(), `ov007-${viewport.width}x${viewport.height}.png`) });
  }
  widget.h = 8; // 9:16 레이아웃에 이미 저장된 기존 기본 크기
  await page.goto("/overlay/mock-token");
  await expect(card).toBeVisible();
  expect(await card.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
});
