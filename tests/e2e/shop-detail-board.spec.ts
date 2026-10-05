import { expect, test, type Page } from "@playwright/test";
import { clearCouponsInDb, createClaimableCouponInDb } from "./couponDb";

// 보드 SH-003-IA 맞춤: 탭(리뷰·상품 문의 개수), 상품 문의 목록·쓰기, 쿠폰 받기 줄, 공유, 최근 본 상품, 버튼 순서(장바구니·찜·공유·구매하기).
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const TITLE = `e2e 문의 ${Date.now().toString(36)}`;

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await clearCouponsInDb(SLUG);
});
test.afterAll(() => clearCouponsInDb(SLUG));

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
async function productIdOf(page: Page, name: string) {
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
  return list.products.find((p) => p.name === name)!.id;
}

test("상품 문의: 쓰기(공개·비공개) → 목록·탭 개수 → 지우기, 비회원은 로그인 안내", async ({ page, baseURL }) => {
  const id = await productIdOf(page, "탑로더 25장");
  await page.goto(`/shop/${SLUG}/products/${id}`);
  const qna = page.getByRole("region", { name: /^상품 문의/ });
  await expect(qna.getByText("아직 문의가 없어요")).toBeVisible();
  await qna.getByRole("button", { name: "문의하기" }).click();
  await expect(page.getByRole("dialog", { name: "로그인이 필요해요" })).toBeVisible();

  await login(page, baseURL!);
  await page.goto(`/shop/${SLUG}/products/${id}`);
  await qna.getByRole("button", { name: "문의하기" }).click();
  const dlg = page.getByRole("dialog", { name: "상품 문의" });
  await expect(dlg.getByRole("button", { name: "문의 남기기" })).toBeDisabled();
  await dlg.getByLabel("제목").fill(TITLE);
  await dlg.getByLabel("내용").fill("박스 크기가 어떻게 되나요?");
  await dlg.getByRole("button", { name: "문의 남기기" }).click();
  await expect(qna.getByText("문의를 남겼어요")).toBeVisible();
  await expect(qna.getByText(TITLE)).toBeVisible();
  await expect(qna.getByText("답변 대기").first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "상품 상세 메뉴" }).getByRole("link", { name: /상품 문의/ })).toContainText("1");

  // 비공개로 남기면 목록에는 「비밀글이에요」만 보인다
  await qna.getByRole("button", { name: "문의하기" }).click();
  await dlg.getByLabel("제목").fill("비밀 문의");
  await dlg.getByLabel("내용").fill("개인 정보가 들어 있어요");
  await dlg.getByLabel(/비공개로 남겨요/).check();
  await dlg.getByRole("button", { name: "문의 남기기" }).click();
  await expect(qna.getByText("🔒 비밀글이에요")).toBeVisible();
  await expect(qna.getByText("개인 정보가 들어 있어요")).toHaveCount(0);

  // 정리: 내 문의를 지운다(답변이 없어 지울 수 있다)
  const mine = (await (await page.request.get(`/api/shop/${SLUG}/inquiries`)).json()) as { inquiries: { id: string }[] };
  for (const q of mine.inquiries) {
    const r = await page.request.delete(`/api/shop/${SLUG}/inquiries/${q.id}`, { headers: { origin: baseURL! } });
    expect(r.ok()).toBe(true);
  }
});

test("쿠폰 받기 줄·버튼 순서·공유(주소 복사)", async ({ page, baseURL, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await createClaimableCouponInDb(SLUG, "상세 시험 쿠폰", 2000);
  await login(page, baseURL!);
  const id = await productIdOf(page, "탑로더 25장");
  await page.goto(`/shop/${SLUG}/products/${id}`);
  const row = page.locator("tr", { has: page.getByRole("rowheader", { name: "쿠폰" }) });
  await expect(row).toContainText("상세 시험 쿠폰");
  await row.getByRole("button", { name: "쿠폰 받기" }).click();
  await expect(row.getByText("쿠폰을 받았어요")).toBeVisible();

  const names = await page.locator(".pd-actions button").allInnerTexts();
  expect(names.map((n) => n.trim())).toEqual(["♡", "공유", "장바구니에 담기", "바로 주문하기"]);
  // PC는 장바구니에 담기 · 찜 · 공유 · 바로 주문하기 순서로 보인다(보드 SH-003-PC-IA)
  const xs = await page.locator(".pd-actions button").evaluateAll((els) => els.map((e) => ({ t: (e.textContent ?? "").trim(), x: e.getBoundingClientRect().left })));
  expect(xs.sort((a, b) => a.x - b.x).map((e) => e.t)).toEqual(["장바구니에 담기", "♡", "공유", "바로 주문하기"]);
  await page.getByRole("button", { name: "공유" }).click();
  await expect(page.getByText("상품 주소를 복사했어요")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`/products/${id}`);
});

test("최근 본 상품: 다른 상품을 본 뒤 상세에 보이고, 지금 상품은 빠진다", async ({ page }) => {
  const a = await productIdOf(page, "탑로더 25장");
  const b = await productIdOf(page, "스타라이트 부스터 박스");
  await page.goto(`/shop/${SLUG}/products/${a}`);
  await expect(page.getByRole("region", { name: "최근 본 상품" })).toHaveCount(0); // 처음이면 없음
  await page.goto(`/shop/${SLUG}/products/${b}`);
  const recent = page.getByRole("region", { name: "최근 본 상품" });
  await expect(recent.getByRole("link", { name: "탑로더 25장", exact: true })).toBeVisible();
  await expect(recent.getByRole("link", { name: "스타라이트 부스터 박스", exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "상품 상세 메뉴" })).toBeVisible();
});

test("휴대폰 390: 찜 · 공유 · 장바구니에 담기 · 바로 주문하기가 한 줄에 들어가고 가로 스크롤이 없다(보드 SH-003-IA)", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, baseURL!);
  const id = await productIdOf(page, "탑로더 25장");
  await page.goto(`/shop/${SLUG}/products/${id}`);
  const boxes = await page.locator(".pd-actions button").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { t: (e.textContent ?? "").trim(), x: r.left, y: r.top, w: r.width, h: r.height, sw: e.scrollWidth, cw: e.clientWidth }; }));
  expect(boxes.map((b) => b.t)).toEqual(["♡", "공유", "장바구니에 담기", "바로 주문하기"]);
  expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1); // 한 줄
  expect([...boxes].sort((a, b) => a.x - b.x).map((b) => b.t)).toEqual(["♡", "공유", "장바구니에 담기", "바로 주문하기"]);
  expect(Math.round(boxes[0].w)).toBe(44);
  expect(Math.round(boxes[1].w)).toBe(44);
  for (const b of boxes) expect(b.sw).toBeLessThanOrEqual(b.cw + 1); // 글자가 칸을 넘치지 않는다
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // 화면 아래 고정 바: 아래 탭 대신 보이고, 화면 맨 아래에 붙는다(스크롤해도 그대로)
  const bar = page.locator(".pd-actions");
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  await expect(page.getByRole("navigation", { name: "바로 가기" })).toBeHidden();
  await page.mouse.wheel(0, 1500);
  const rect = await bar.evaluate((el) => { const r = el.getBoundingClientRect(); return { bottom: r.bottom, left: r.left, right: r.right, vh: window.innerHeight, vw: window.innerWidth }; });
  expect(Math.round(rect.bottom)).toBe(rect.vh);
  expect(Math.round(rect.left)).toBe(0);
  expect(Math.round(rect.right)).toBe(rect.vw);
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: "tests/e2e/screenshots/SH-003-pd-bar-390.png" });
});

test("PC·태블릿: 하단 바는 고정되지 않고 상품 정보 아래에 있다", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  const id = await productIdOf(page, "탑로더 25장");
  for (const [w, name] of [[1024, "1024"], [1440, "1440"]] as const) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`/shop/${SLUG}/products/${id}`);
    expect(await page.locator(".pd-actions").evaluate((el) => getComputedStyle(el).position)).not.toBe("fixed");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: `tests/e2e/screenshots/SH-003-pd-bar-${name}.png` });
  }
});
