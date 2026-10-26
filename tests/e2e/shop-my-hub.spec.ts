import { expect, test, type Page } from "@playwright/test";

// 보드 SH-020-IA(휴대폰)·SH-020-PC-IA: 내 정보 허브 — 요약 칸(기다리는 주문·적립금·쿠폰·등급) · PC 왼쪽 4그룹 메뉴 + 최근 주문 표 · 휴대폰 프로필 줄 + 메뉴 목록. 실제 서버·DB.
const SLUG = "demo-shop";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = "tests/e2e/screenshots";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}

test("PC 1440: 왼쪽 4그룹 메뉴 + 요약 4칸 + 최근 주문 5건, 값은 서버 값이다", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = (await (await page.request.get(`/api/shop/${SLUG}/orders?limit=20`)).json()) as { orders: { orderNoLabel: string }[] };
  await page.goto(`/shop/${SLUG}/me`);
  await expect(page.getByRole("heading", { name: "내 정보", level: 1 })).toBeVisible();
  const menu = page.getByRole("navigation", { name: "내 정보 메뉴" });
  for (const g of ["쇼핑", "혜택", "활동", "내 정보"]) await expect(menu.locator(".my-menu-g", { hasText: new RegExp(`^${g}$`) })).toBeVisible();
  await expect(menu.getByRole("button", { name: "로그아웃" })).toBeVisible();
  const stats = page.getByLabel("내 요약");
  for (const k of ["기다리는 주문", "적립금", "쿠폰", "회원 등급"]) await expect(stats.getByText(k, { exact: true })).toBeVisible();
  await expect(stats.getByText("0원").or(stats.getByText(/\d[\d,]*원/)).first()).toBeVisible();
  const rows = page.locator(".hub-tbl tbody tr");
  await expect(rows).toHaveCount(Math.min(5, api.orders.length));
  await expect(rows.first()).toContainText(api.orders[0].orderNoLabel);
  await expect(page.locator(".hub-mlist")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/sh020-hub-1440.png`, fullPage: true });
  // 메뉴로 도달: 요약 칸 · 「더 보기」 · 「주문 상세」
  await stats.getByRole("link", { name: /적립금/ }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/me/rewards$`));
  await page.goto(`/shop/${SLUG}/me`);
  await page.getByRole("link", { name: "더 보기 ›" }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/orders$`));
});

test("휴대폰 390: 프로필 줄 · 요약 3칸 · 메뉴 목록(›)·로그아웃, 최근 주문 표는 없다", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/shop/${SLUG}/me`);
  await expect(page.locator(".hub-profile")).toContainText("내 등급");
  await expect(page.locator(".hub-profile").getByRole("link", { name: "수정" })).toHaveAttribute("href", `/shop/${SLUG}/me/profile`);
  await expect(page.locator(".hub-stat:visible")).toHaveCount(3);
  await expect(page.locator(".hub-recent")).toBeHidden();
  const list = page.locator(".hub-mlist");
  for (const l of ["주문 내역", "배송지 관리", "내 적립금", "내 쿠폰함", "내 문의", "내 리뷰", "회원정보 수정", "알림 설정"]) await expect(list.getByRole("link", { name: l })).toBeVisible();
  await expect(list.getByRole("button", { name: "로그아웃" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/sh020-hub-390.png`, fullPage: true });
});

test("PC 1440: 최근 주문 「관리」 열은 상태별 버튼(취소 요청·방송 보기 · 배송 조회 · 리뷰 쓰기 · 다시 담기)", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  const item = { productNameSnapshot: "테스트 상품", optionNameSnapshot: "1박스", quantity: 1, optionId: "opt1" };
  const base = { totalAmount: 10000, createdAt: new Date().toISOString(), items: [item], counts: undefined };
  const mk = (n: number, status: string, queue: unknown, shipment: unknown) => ({ id: `o${n}`, orderNoLabel: `T-${n}`, status, queue, shipment, ...base });
  const orders = [
    mk(1, "PAID", { status: "WAITING", aheadCount: 3 }, null),
    mk(2, "PAID", { status: "DONE", aheadCount: 0 }, { status: "IN_TRANSIT", courier: "CJ", trackingNumber: "123456789012" }),
    mk(3, "PAID", { status: "DONE", aheadCount: 0 }, { status: "DELIVERED", courier: "CJ", trackingNumber: "123456789012" }),
    mk(4, "CANCELLED", null, null),
  ];
  await page.route(`**/api/shop/${SLUG}/orders?limit=*`, (r) => r.fulfill({ json: { orders, nextCursor: null, counts: { inProgress: 1 } } }));
  await page.route(`**/api/shop/${SLUG}/live`, (r) => r.fulfill({ json: { live: true, title: "방송", watchUrl: "https://example.com/watch" } }));
  await page.goto(`/shop/${SLUG}/me`);
  const row = (n: number) => page.locator("tr", { hasText: `T-${n}` });
  await expect(row(1).getByRole("link", { name: "취소 요청" })).toHaveAttribute("href", `/shop/${SLUG}/orders/o1`);
  await expect(row(1).getByRole("link", { name: "방송 보기" })).toHaveAttribute("href", "https://example.com/watch");
  await expect(row(2).getByRole("link", { name: "배송 조회" })).toHaveAttribute("href", /cjlogistics/);
  await expect(row(3).getByRole("link", { name: "리뷰 쓰기" })).toHaveAttribute("href", `/shop/${SLUG}/reviews`);
  await expect(row(4).getByRole("button", { name: "다시 담기" })).toBeVisible();
});
