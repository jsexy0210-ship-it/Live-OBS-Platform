import { expect, test, type Page } from "@playwright/test";
import { clearCouponsInDb, createClaimableCouponInDb } from "./couponDb";
import { okConfirm } from "./shopConfirm";

// SH-003 FINAL v284: 정보 순서·상품 문의·쿠폰·공유·최근 본 상품과 모바일 고정 구매 바.
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

async function expectInfoLayout(page: Page, width: number) {
  await expect(page.locator(".pd-price-summary")).toBeVisible();
  await expect(page.locator(".pd-rating")).toBeVisible();
  await expect(page.locator(".pd-coupon-row")).toContainText("세 폭 화면 검수 쿠폰");
  const actionOrder = await page.locator(".pd-actions button").evaluateAll((els) =>
    els.map((el) => ({ name: (el.textContent ?? "").trim(), left: el.getBoundingClientRect().left }))
      .sort((a, b) => a.left - b.left)
      .map(({ name }) => name),
  );
  expect(actionOrder).toEqual(["♡", "공유", "장바구니에 담기", "바로 주문하기"]);
  const infoOrder = await page.locator(".pd-info").evaluate((info) => {
    const children = [...info.children];
    return [".pd-crumb", "h1", ".pd-rating", ".pd-desc", ".pd-price-summary"]
      .map((selector) => children.findIndex((el) => el.matches(selector)))
      .filter((index) => index >= 0);
  });
  expect(infoOrder).toEqual([...infoOrder].sort((a, b) => a - b));
  const geometry = await page.locator(".pd-top").evaluate((top) => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    };
    return {
      container: rect(top),
      gallery: rect(top.querySelector(".pd-gallery")!),
      info: rect(top.querySelector(".pd-info")!),
    };
  });
  expect(Math.abs(geometry.gallery.left - geometry.container.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.info.right - geometry.container.right)).toBeLessThanOrEqual(1);
  if (width <= 767) {
    expect(Math.abs(geometry.info.left - geometry.gallery.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.info.right - geometry.gallery.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.info.width - geometry.gallery.width)).toBeLessThanOrEqual(1);
  }
  const priceBottom = await page.locator(".pd-price-summary").evaluate((el) => el.getBoundingClientRect().bottom);
  const rows = await page.locator(".pd-form-row").evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect();
      return { name: ["pd-coupon-row", "pd-reward-row", "pd-stock-row", "pd-shipping-row", "pd-option-row", "pd-quantity-row"].find((name) => el.classList.contains(name))!, top: rect.top, bottom: rect.bottom };
    }),
  );
  const order = ["pd-coupon-row", "pd-reward-row", "pd-stock-row", "pd-shipping-row", "pd-option-row", "pd-quantity-row"];
  const ranks = rows.map((row) => order.indexOf(row.name));
  expect(ranks.every((rank) => rank >= 0)).toBe(true);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  expect(priceBottom).toBeLessThanOrEqual(rows[0].top + 1);
  for (let i = 0; i < rows.length - 1; i++) expect(rows[i].bottom).toBeLessThanOrEqual(rows[i + 1].top + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.E2E_SCREENSHOTS === "1" && width !== 390) await page.screenshot({ path: `tests/e2e/screenshots/SH-003-info-${width}.png`, fullPage: true });
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
  await okConfirm(page, "남기기");
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
  await okConfirm(page, "남기기");
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
  const row = page.locator(".pd-coupon-row");
  await expect(row).toContainText("상세 시험 쿠폰");
  await row.getByRole("button", { name: "쿠폰 받기" }).click();
  await expect(row.getByText("쿠폰을 받았어요")).toBeVisible();

  const names = await page.locator(".pd-actions button").allInnerTexts();
  expect(names.map((n) => n.trim())).toEqual(["♡", "공유", "장바구니에 담기", "바로 주문하기"]);
  const actionBoxes = await page.locator(".pd-actions button").evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
  expect(actionBoxes).toHaveLength(4);
  expect(new Set(actionBoxes.map((b) => Math.round(b.top))).size).toBe(1);
  const visualOrder = [...actionBoxes].sort((a, b) => a.left - b.left);
  for (let i = 0; i < visualOrder.length - 1; i++) expect(visualOrder[i].right).toBeLessThanOrEqual(visualOrder[i + 1].left + 1);
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
  await createClaimableCouponInDb(SLUG, "세 폭 화면 검수 쿠폰", 2000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, baseURL!);
  const id = await productIdOf(page, "탑로더 25장");
  await page.goto(`/shop/${SLUG}/products/${id}`);
  await expectInfoLayout(page, 390);
  await page.locator(".pd-shipping-row").scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const quantity = document.querySelector(".pd-quantity-row")!.getBoundingClientRect();
    const actions = document.querySelector(".pd-actions")!.getBoundingClientRect();
    const overlap = quantity.bottom - actions.top + 8;
    if (overlap > 0) window.scrollBy(0, overlap);
  });
  const visibleRows = await page.locator(".pd-shipping-row, .pd-option-row, .pd-quantity-row").evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }),
  );
  expect(visibleRows).toHaveLength(3);
  const actionTop = await page.locator(".pd-actions").evaluate((el) => el.getBoundingClientRect().top);
  for (const row of visibleRows) {
    expect(row.top).toBeGreaterThanOrEqual(0);
    expect(row.bottom).toBeLessThanOrEqual(actionTop - 8);
  }
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: "tests/e2e/screenshots/SH-003-info-390.png" });
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
    await expectInfoLayout(page, w);
    expect(await page.locator(".pd-actions").evaluate((el) => getComputedStyle(el).position)).not.toBe("fixed");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: `tests/e2e/screenshots/SH-003-pd-bar-${name}.png` });
  }
});

// 모달(상품 문의) 위에 확인 창이 겹칠 때: Esc는 위(확인 창)만 닫고, 포커스는 아래 모달로 돌아온다.
test("문의 창 위의 확인 창: Esc로 확인 창만 닫히고 문의 창·입력 내용은 그대로, 취소하면 서버에 보내지 않는다", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  const id = await productIdOf(page, "탑로더 25장");
  await page.goto(`/shop/${SLUG}/products/${id}`);
  let posts = 0;
  await page.route("**/api/shop/*/inquiries", (route) => {
    if (route.request().method() === "POST") posts += 1;
    return route.continue();
  });
  await page.getByRole("region", { name: /^상품 문의/ }).getByRole("button", { name: "문의하기" }).click();
  const dlg = page.getByRole("dialog", { name: "상품 문의" });
  await dlg.getByLabel("제목").fill("겹침 시험");
  await dlg.getByLabel("내용").fill("확인 창 위에서 Esc를 눌러 봐요");
  const send = dlg.getByRole("button", { name: "문의 남기기" });
  await send.click();
  const cfm = page.getByRole("dialog", { name: "문의를 남길까요?" });
  await expect(cfm).toBeVisible();
  await expect(cfm.getByRole("button", { name: "취소" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(cfm).toHaveCount(0);
  await expect(dlg).toBeVisible(); // 아래 문의 창은 남아 있다
  await expect(dlg.getByLabel("제목")).toHaveValue("겹침 시험");
  await expect(send).toBeFocused(); // 포커스가 확인 창을 연 버튼으로 돌아온다
  expect(posts).toBe(0);
  await dlg.getByRole("button", { name: "취소" }).click(); // 문의 창을 닫는다(보내지 않음)
  await expect(dlg).toHaveCount(0);
  expect(posts).toBe(0);
});
