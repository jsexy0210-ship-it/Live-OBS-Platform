import { expect, request, test, type Page } from "@playwright/test";
import { jpeg, png } from "../unit/shopContentFixtures";
import { submitSellerLogin } from "./sellerLogin";
import { fillDateTime } from "./dateInput";
import { PrismaClient } from "@prisma/client";
import { hash } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";

// SA-064 홈 배너 관리·SA-065 이벤트 팝업 관리(파트너스 관리자, 설정 › 배너 · 팝업)와 구매자 쇼핑몰 홈 표시.
// 실행 시작·끝에 데모 쇼핑몰의 배너·팝업을 모두 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SHOT = "tests/e2e/screenshots";

async function clearAll() {
  const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
  try {
    expect((await ctx.post("/api/seller/auth/login", { data: { email: "demo-owner@example.com", password: PASSWORD } })).ok()).toBe(true);
    expect((await ctx.put("/api/seller/shop-content/banners/interval", { data: { intervalSec: 0 } })).ok()).toBe(true);
    for (const kind of ["banners", "popups"] as const) {
      const list = (await (await ctx.get(`/api/seller/shop-content/${kind}`)).json()) as Record<string, { id: string }[]>;
      for (const it of list[kind]) expect((await ctx.delete(`/api/seller/shop-content/${kind}/${it.id}`)).ok()).toBe(true);
    }
  } finally {
    await ctx.dispose();
  }
}

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await clearAll();
});
test.afterAll(clearAll);

test("SH-001 홈: 소유 폐기 fixture의 방송·추천·7일 신상품·종료·빈 상태를 세 폭에서 확인한다", async ({ page }) => {
  const db = new PrismaClient();
  const suffix = randomBytes(5).toString("hex");
  const slug = `home-final-${suffix}`;
  let sellerId: string | undefined;
  const names = ["방송 상품", "추천 상품", "취소된 방송 상품", "품절 상품"];
  try {
    const seller = await db.seller.create({ data: { slug, shopName: "홈 진열 검수", status: "ACTIVE", approvedAt: new Date(), trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
    sellerId = seller.id;
    const grade = await db.memberGrade.create({ data: { sellerId, displayName: "일반", sortOrder: 0 } });
    const buyer = await db.buyerMember.create({ data: { sellerId, gradeId: grade.id, loginId: `home-${suffix}@example.test`, passwordHash: await hash(randomBytes(20).toString("hex")), name: "홈 검수", phone: "01000000000", ciHash: suffix, identityVerifiedAt: new Date(), birthDate: new Date("1990-01-01"), broadcastNickname: "검수 구매자" } });
    const session = await db.broadcastSession.create({ data: { sellerId, title: "홈 진열 방송" } });
    const products = [];
    for (let i = 0; i < names.length; i++) {
      const p = await db.product.create({ data: { sellerId, name: names[i], price: 1000 * (i + 1), status: i === 3 ? "SOLD_OUT" : "ON_SALE", sortOrder: i, createdAt: new Date(Date.now() - (i === 1 ? 8 * 86_400_000 : 60_000)) } });
      products.push(p);
      const option = await db.productOption.create({ data: { sellerId, productId: p.id, name: "기본", stock: i === 3 ? 0 : 10 } });
      const order = await db.order.create({ data: { sellerId, buyerMemberId: buyer.id, orderNo: i + 1, broadcastNicknameSnapshot: "검수 구매자", totalAmount: p.price, status: "PAID" } });
      const item = await db.orderItem.create({ data: { sellerId, orderId: order.id, productId: p.id, optionId: option.id, productNameSnapshot: p.name, optionNameSnapshot: "기본", unitPrice: p.price, quantity: 1 } });
      await db.queueItem.create({ data: { sellerId, orderId: order.id, orderItemId: item.id, broadcastSessionId: session.id, status: i === 2 ? "CANCELLED" : "WAITING", position: i, receivedAt: new Date(Date.now() + i), nicknameSnapshot: "검수 구매자", productLabel: p.name, quantity: 1 } });
    }
    // 추천은 최신순과 다른, 판매자가 저장한 순서다.
    await db.shopDisplayItem.createMany({ data: [1, 0, 3].map((i, sortOrder) => ({ sellerId: seller.id, productId: products[i].id, sortOrder })) });
    for (const [i, kind] of (["LIVE", "RECOMMENDED", "NEW"] as const).entries()) await db.shopDisplaySection.create({ data: { sellerId, kind, title: ["방송 중 상품", "추천 상품", "신상품"][i], itemCount: 4, sortOrder: i } });
    await db.shopNotice.create({ data: { sellerId, kind: "NOTICE", title: "홈 진열 공지", body: "검수 공지", isPublished: true, isPinned: true } });
    const base = `/shop/${slug}`;
    const response = await page.request.get(`/api/shop/${slug}/home`);
    expect(response.status()).toBe(200);
    const actual = await response.json() as { sections: { kind: string; products: { name: string }[] }[] };
    expect(actual.sections.map(s => s.kind)).toEqual(["LIVE", "RECOMMENDED", "NEW"]);
    expect(actual.sections.find(s => s.kind === "RECOMMENDED")!.products.map(p => p.name)).toEqual([names[1], names[0], names[3]]);
    expect(actual.sections.find(s => s.kind === "NEW")!.products.map(p => p.name)).not.toContain(names[1]);
    const mutations: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname.startsWith(`/api/shop/${slug}/`) && !["GET", "HEAD"].includes(request.method())) mutations.push(request.method());
    });
    for (const state of ["live", "ended", "empty"] as const) {
      if (state === "ended") await db.broadcastSession.update({ where: { id: session.id }, data: { status: "ENDED", endedAt: new Date() } });
      if (state === "empty") await db.product.updateMany({ where: { sellerId }, data: { status: "HIDDEN" } });
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(base);
        if (state === "empty") {
          await expect(page.getByText("아직 올라온 상품이 없어요.", { exact: true })).toBeVisible();
          await expect(page.locator(".shop-home .pc")).toHaveCount(0);
        } else {
          await expect(page.locator(".shop-home-kind-live h2")).toHaveText(state === "live" ? "방송 중 상품" : "최근 방송 상품");
          await expect(page.locator(".shop-home-kind-recommended .pc-name")).toHaveText([names[1], names[0], names[3]]);
          await expect(page.locator(".shop-home-kind-live .pc-name")).not.toContainText([names[2]]);
          await expect(page.locator(".shop-home-kind-new .pc-name")).not.toContainText([names[1]]);
          await expect(page.locator(".shop-home-kind-new .pc")).toHaveCount(3);
          await expect(page.locator(".shop-home-kind-recommended .pc-out")).toHaveCount(1);
          await expect(page.locator(".shop-home-kind-new .shop-more")).toHaveAttribute("href", `${base}/products?sort=new`);
          if (state === "live") await expect(page.locator(".live-bar")).toBeVisible();
          else await expect(page.locator(".live-bar")).toHaveCount(0);
          await expect(page.locator(".shop-home .pc-name").first()).toHaveAttribute("href", new RegExp(`^${base}/products/`));
        }
        if (width === 390) await expect(page.locator(".shop-home-notices")).toBeHidden();
        else await expect(page.locator(".shop-home-notices")).toContainText("홈 진열 공지");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const rects = await page.locator(".shop-home .pc-name,.shop-home .shop-sec-head h2").evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { width: r.width, left: r.left, right: r.right }; }));
        for (const rect of rects) { expect(rect.width).toBeGreaterThan(0); expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(width); }
        await page.screenshot({ path: `${SHOT}/SH-001-home-${state}-${width}.png`, fullPage: true });
      }
    }
    expect(mutations).toEqual([]); // 세션 API 시작·종료, 장바구니·찜·외부 영상은 실행하지 않는다.
  } finally {
    if (sellerId) {
      const where = { sellerId };
      await db.queueItem.deleteMany({ where }); await db.orderItem.deleteMany({ where }); await db.order.deleteMany({ where });
      await db.broadcastSession.deleteMany({ where }); await db.shopNotice.deleteMany({ where });
      await db.shopDisplayItem.deleteMany({ where }); await db.shopDisplaySection.deleteMany({ where });
      await db.productOption.deleteMany({ where }); await db.product.deleteMany({ where });
      await db.buyerMember.deleteMany({ where }); await db.memberGrade.deleteMany({ where });
      await db.seller.delete({ where: { id: sellerId } });
    }
    await db.$disconnect();
  }
});

async function ownerOpen(page: Page, path: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(path)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

// 브라우저 캔버스로 만든 실제 PNG(글자가 들어 있어 화면에서 구분된다)
async function canvasPng(page: Page, width: number, height: number, color: string, label: string): Promise<Buffer> {
  const b64 = await page.evaluate(
    ([w, h, c, t]) => {
      const cv = document.createElement("canvas");
      cv.width = w as number;
      cv.height = h as number;
      const g = cv.getContext("2d")!;
      g.fillStyle = c as string;
      g.fillRect(0, 0, cv.width, cv.height);
      g.fillStyle = "#fff";
      g.font = `bold ${Math.round((h as number) / 6)}px sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(t as string, cv.width / 2, cv.height / 2);
      return cv.toDataURL("image/png").split(",")[1];
    },
    [width, height, color, label],
  );
  return Buffer.from(b64, "base64");
}

const file = (name: string, buffer: Buffer, mimeType = "image/png") => ({ name, mimeType, buffer });
const imageLoaded = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0);
async function expectBannerPreview(page: Page, testId: "banner-home-preview" | "banner-preview") {
  const shell = page.locator(".cs");
  const lnb = page.locator(".lnb");
  await expect(shell).not.toHaveClass(/\bnav-open\b/);
  await expect.poll(() => lnb.evaluate((el) => el.getAnimations().every((animation) => animation.playState !== "running"))).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const frame = page.getByTestId(testId);
  const image = frame.locator('.hb-only .hb-slide[aria-hidden="false"] img').first();
  await frame.scrollIntoViewIfNeeded();
  await expect.poll(() => imageLoaded(page, `[data-testid="${testId}"] .hb-only .hb-slide[aria-hidden="false"] img`)).toBe(true);
  const metrics = await image.evaluate((el) => {
    const img = el as HTMLImageElement;
    const frame = img.closest<HTMLElement>("[data-testid]")!;
    const shell = document.querySelector(".cs");
    const lnb = document.querySelector(".lnb");
    const frameRect = frame.getBoundingClientRect();
    const imageRect = img.getBoundingClientRect();
    const lnbRect = lnb!.getBoundingClientRect();
    const leftEdge = document.elementFromPoint(imageRect.left + 1, imageRect.top + imageRect.height / 2);
    return {
      viewportWidth: window.innerWidth,
      scrollX: window.scrollX,
      navOpen: shell?.classList.contains("nav-open"),
      lnbRight: lnbRect.right,
      lnbTransform: getComputedStyle(lnb!).transform,
      frame: { x: frameRect.x, y: frameRect.y, width: frameRect.width, height: frameRect.height, right: frameRect.right },
      leftEdgeUnobscured: !!leftEdge && frame.contains(leftEdge),
      frameWidth: frame.getBoundingClientRect().width,
      imageHeight: imageRect.height,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      objectFit: getComputedStyle(img).objectFit,
    };
  });
  console.log(`[SA-064 preview] ${JSON.stringify(metrics)}`);
  expect(metrics.navOpen).toBe(false);
  expect(metrics.scrollX).toBe(0);
  expect(metrics.frame.x).toBeGreaterThanOrEqual(0);
  expect(metrics.frame.right).toBeLessThanOrEqual(metrics.viewportWidth);
  if (metrics.viewportWidth <= 1023) expect(metrics.lnbRight).toBeLessThanOrEqual(0);
  expect(metrics.leftEdgeUnobscured).toBe(true);
  expect(metrics.frameWidth).toBe(240);
  expect(metrics.imageHeight).toBe(80);
  expect(metrics.naturalWidth).toBe(750);
  expect(metrics.naturalHeight).toBe(750);
  expect(metrics.objectFit).toBe("cover");
}
// 지금 KST 기준 날짜(YYYY-MM-DD)
const kstDay = (days: number) => new Date(Date.now() + days * 86400_000 + 9 * 3600_000).toISOString().slice(0, 10);
// 지금 KST 기준 datetime-local 값(분 단위)
const kstLocal = (ms: number) => new Date(Date.now() + ms + 9 * 3600_000).toISOString().slice(0, 16);
const POPUP_TITLE = "10/4 토 20시 스타라이트 브레이크";
const BAR_TITLE = "추석 연휴 배송 안내 · 10/2부터 순서대로 보내요";

test.describe.serial("SA-064 홈 배너 · SA-065 이벤트 팝업", () => {
  test("SA-064 대표자: 배너 추가(PNG만·링크 검사·미리보기) → 예약·PC만 배너 → ▲▼ 순서 변경 · 자동 넘김", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ownerOpen(page, "/seller/banners");
    await expect(page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "홈 배너" })).toHaveClass(/on/);
    await expect(page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "홈 배너", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("등록한 배너가 없습니다")).toBeVisible();

    const confirmBtn = (name: string) => page.getByRole("dialog").getByRole("button", { name, exact: true });
    await page.getByRole("button", { name: "배너 추가" }).first().click();
    const ed = page.getByTestId("banner-editor");
    await expect(ed.getByText("1200 × 400 권장 · PNG · 2MB 이하")).toBeVisible();
    await ed.getByLabel("제목 (대체 텍스트)").fill("10월 스타라이트 박스 오픈");
    // PNG가 아닌 파일(JPEG·SVG)은 내용으로 걸러진다
    await ed.getByLabel("PC 이미지", { exact: true }).setInputFiles(file("pc.png", jpeg(1200, 400)));
    await expect(ed.getByText("PNG 파일만 올릴 수 있습니다")).toBeVisible();
    await ed.getByLabel("PC 이미지", { exact: true }).setInputFiles(file("pc.png", await canvasPng(page, 1920, 600, "#5b3df6", "10월 스타라이트 박스")));
    await expect(ed.locator(".sc-up-img").first()).toBeVisible();
    await expect.poll(() => imageLoaded(page, ".sc-up-img")).toBe(true);
    // 권장보다 작은 모바일 이미지는 올라가지만 안내가 보인다 → 권장 크기로 바꾼다
    await ed.getByLabel("모바일 이미지", { exact: true }).setInputFiles(file("m.png", png(300, 300)));
    await expect(ed.getByText("가로 750px 이상 이미지를 권장합니다 · 지금 파일은 300×300입니다 (올릴 수는 있음)")).toBeVisible();
    await ed.getByLabel("모바일 이미지", { exact: true }).setInputFiles(file("m.png", await canvasPng(page, 750, 750, "#7b5cff", "MOBILE")));
    // 연결: 상품 상세(검색해서 고름) · 카테고리 · 직접 입력한 주소
    await ed.getByLabel("연결", { exact: true }).selectOption("product");
    await expect(ed.getByLabel("상품 이름 검색")).toBeVisible();
    await ed.getByLabel("연결", { exact: true }).selectOption("category");
    await expect(ed.getByLabel("카테고리")).toBeVisible();
    await ed.getByLabel("연결", { exact: true }).selectOption("custom");
    await ed.getByLabel("연결 주소").fill("javascript:alert(1)");
    await expect(ed.getByText("쇼핑몰 안 경로(/로 시작) 또는 http(s) 주소만 입력할 수 있습니다")).toBeVisible();
    await ed.getByLabel("게시 시작일").fill(kstDay(0));
    await expect(ed.getByRole("button", { name: "저장" })).toBeDisabled();
    await ed.getByLabel("연결 주소").fill("/signup");
    await expect(ed.getByRole("button", { name: "저장" })).toBeEnabled();
    await ed.getByRole("button", { name: "미리보기" }).click();
    expect(await imageLoaded(page, '[data-testid="banner-preview"] img')).toBe(true);
    for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await expectBannerPreview(page, "banner-preview");
      await page.screenshot({ path: `${SHOT}/SA-064-banner-edit-preview-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `${SHOT}/SA-064-banner-edit-1440.png` });
    await ed.getByRole("radio", { name: "모바일만" }).click();
    await expectBannerPreview(page, "banner-preview");
    // 저장은 PC · 모바일로 한다(아래 구매자 화면 시험이 PC 슬라이드 2장 · 모바일 슬라이드 1장을 기대한다)
    await ed.getByRole("radio", { name: "PC · 모바일" }).click();
    await ed.getByRole("button", { name: "저장" }).click();
    await confirmBtn("추가").click();
    await expect(page.getByText("배너를 추가했습니다 · 홈에 바로 반영")).toBeVisible();
    for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await expectBannerPreview(page, "banner-home-preview");
      await page.screenshot({ path: `${SHOT}/SA-064-banner-home-preview-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // 두 번째: 내일 시작(예약)
    await page.getByRole("button", { name: "배너 추가" }).first().click();
    const d2 = page.getByTestId("banner-editor");
    await d2.getByLabel("제목 (대체 텍스트)").fill("주말 브레이크 안내");
    await d2.getByLabel("PC 이미지", { exact: true }).setInputFiles(file("pc2.png", await canvasPng(page, 1920, 600, "#e8382d", "주말 브레이크")));
    await expect(d2.locator(".sc-up-img")).toBeVisible();
    await d2.getByLabel("게시 시작일").fill(kstDay(1));
    await d2.getByRole("button", { name: "저장" }).click();
    await confirmBtn("추가").click();
    await expect(page.getByTestId("banner-row")).toHaveCount(2);
    // 세 번째: PC만
    await page.getByRole("button", { name: "배너 추가" }).first().click();
    const d3 = page.getByTestId("banner-editor");
    await d3.getByLabel("제목 (대체 텍스트)").fill("회원 등급 혜택");
    await d3.getByLabel("PC 이미지", { exact: true }).setInputFiles(file("pc3.png", await canvasPng(page, 1920, 600, "#0f8a5f", "회원 혜택 · PC만")));
    await expect(d3.locator(".sc-up-img")).toBeVisible();
    await d3.getByLabel("게시 시작일").fill(kstDay(0));
    await d3.getByRole("radio", { name: "PC만" }).click();
    await d3.getByRole("button", { name: "저장" }).click();
    await confirmBtn("추가").click();

    await expect(page.getByTestId("banner-row")).toHaveCount(3);
    await expect(page.getByTestId("banner-summary")).toContainText("배너 3장");
    await expect(page.getByTestId("banner-row").nth(1).getByText("예약")).toBeVisible();
    await expect(page.getByTestId("banner-row").nth(2)).toContainText("PC만");

    // ▲▼로 순서 바꾸기 → 맨 위 ▲와 맨 아래 ▼는 꺼져 있고, 새로고침해도 유지
    await expect(page.getByTestId("banner-row").nth(0).getByRole("button", { name: /위로$/ })).toBeDisabled();
    await expect(page.getByTestId("banner-row").nth(2).getByRole("button", { name: /아래로$/ })).toBeDisabled();
    await page.getByRole("button", { name: "회원 등급 혜택 위로" }).click();
    await expect(page.getByText("순서를 저장했습니다")).toBeVisible();
    await page.getByRole("button", { name: "회원 등급 혜택 위로" }).click();
    await expect(page.getByText("순서를 저장했습니다")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("banner-row").nth(0)).toContainText("회원 등급 혜택");
    await page.getByRole("button", { name: "10월 스타라이트 박스 오픈 위로" }).click();
    await expect(page.getByText("순서를 저장했습니다")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("banner-row").nth(0)).toContainText("10월 스타라이트 박스 오픈");

    // 자동 넘김: 기본 끔 → 5초(확인 창) → 구매자 홈 데이터에 반영
    await expect(page.getByLabel("자동 넘김")).toHaveValue("0");
    await page.getByLabel("자동 넘김").selectOption("5");
    await confirmBtn("바꾸기").click();
    await expect(page.getByText("자동 넘김을 바꿨습니다 · 홈에 바로 반영")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("자동 넘김")).toHaveValue("5");
    const home = await page.evaluate(async () => (await (await fetch("/api/shop/demo-shop/shop-content?page=home")).json()) as { bannerIntervalSec?: number });
    expect(home.bannerIntervalSec).toBe(5);
    await page.screenshot({ path: `${SHOT}/SA-064-banners-1440.png`, fullPage: true });

    // 이미지를 올리는 동안은 저장할 수 없다(옛 이미지로 저장되지 않게)
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/seller/shop-content/images", async (route) => {
      await held;
      await route.continue();
    });
    await page.getByTestId("banner-row").nth(0).getByRole("button", { name: "수정" }).click();
    const edit = page.getByTestId("banner-editor");
    await expect(edit.getByRole("button", { name: "저장" })).toBeEnabled();
    await edit.getByLabel("PC 이미지", { exact: true }).setInputFiles(file("pc4.png", await canvasPng(page, 1920, 600, "#5b3df6", "10월 스타라이트 박스")));
    await expect(edit.getByRole("button", { name: "이미지 올리는 중" })).toBeDisabled();
    release();
    await expect(edit.getByRole("button", { name: "저장" })).toBeEnabled();
    await page.unroute("**/api/seller/shop-content/images");
    await edit.getByRole("button", { name: "닫기" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByTestId("banner-row")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOT}/SA-064-banners-390.png`, fullPage: true });
  });

  test("SA-064 연결: 상품 상세는 검색해서 고르고, 카테고리는 선택 상자에서 고르면 구매자 링크 주소로 저장된다", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
    await ctx.post("/api/seller/auth/login", { data: { email: "demo-owner@example.com", password: PASSWORD } });
    const name = `배너연결상품 ${Date.now()}`;
    const created = await ctx.post("/api/seller/products", { data: { name, price: 12000, status: "ON_SALE", options: [{ name: "기본", priceDelta: 0, stock: 5, sortOrder: 0 }] } });
    expect(created.status()).toBe(201);
    const productId = ((await created.json()) as { id: string }).id;
    try {
      await ownerOpen(page, "/seller/banners");
      await page.getByTestId("banner-row").nth(0).getByRole("button", { name: "수정" }).click();
      const ed = page.getByTestId("banner-editor");
      await ed.getByLabel("연결", { exact: true }).selectOption("product");
      await ed.getByLabel("상품 이름 검색").fill("배너연결상품");
      await ed.getByRole("button", { name }).click();
      await expect(ed.getByTestId("link-product")).toContainText(name);
      await ed.getByRole("button", { name: "저장" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
      await expect(page.getByText("배너를 저장했습니다 · 홈에 바로 반영")).toBeVisible();
      const list = (await (await ctx.get("/api/seller/shop-content/banners")).json()) as { banners: { linkUrl: string | null }[] };
      expect(list.banners.map((b) => b.linkUrl)).toContain(`/products/${productId}`);
      // 다시 열면 고른 상품 이름이 보인다
      await page.getByTestId("banner-row").nth(0).getByRole("button", { name: "수정" }).click();
      await expect(page.getByTestId("banner-editor").getByTestId("link-product")).toContainText(name);
    } finally {
      await ctx.delete(`/api/seller/products/${productId}`);
      await ctx.dispose();
    }
  });

  test("SA-065 대표자: 이미지 팝업(전체 페이지·7일 보지 않기)과 상단 띠 추가, 복제", async ({ page }) => {
    const confirmBtn = (name: string) => page.getByRole("dialog").getByRole("button", { name, exact: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await ownerOpen(page, "/seller/banners/popups");
    await expect(page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "이벤트 팝업", exact: true })).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "팝업 추가" }).first().click();
    const dialog = page.getByTestId("popup-editor");
    // 이미지 팝업은 이미지가 있어야 저장된다
    await dialog.getByLabel("제목 (대체 텍스트)").fill(POPUP_TITLE);
    await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
    await dialog.getByLabel("이미지", { exact: true }).setInputFiles(file("ev.png", await canvasPng(page, 600, 600, "#ffc451", "LIVE 20:00")));
    await expect(dialog.locator(".sc-up-img")).toBeVisible();
    await dialog.getByLabel("내용").fill("방송 중 주문은 순서대로 열어 드려요.\n주문할 때 방송 닉네임을 꼭 적어 주세요.");
    await dialog.getByLabel("연결", { exact: true }).selectOption("custom");
    await dialog.getByLabel("연결 주소").fill("/signup");
    await dialog.getByLabel("버튼 이름").fill("회원가입하기");
    await dialog.getByLabel("노출 페이지").selectOption("ALL");
    await dialog.getByRole("radio", { name: "7일 동안 보지 않기" }).click();
    await expect(page.getByTestId("popup-preview")).toContainText("회원가입하기");
    await expect(page.getByTestId("popup-preview")).toContainText("7일 동안 보지 않기");
    await dialog.getByRole("radio", { name: "PC만" }).click();
    await expect(page.getByTestId("popup-preview")).toContainText("모바일에서는 표시하지 않음");
    await dialog.getByRole("radio", { name: "PC · 모바일" }).click();
    await page.screenshot({ path: `${SHOT}/SA-065-popup-edit-1440.png` });
    await dialog.getByRole("button", { name: "저장" }).click();
    await confirmBtn("추가").click();
    await expect(page.getByText("팝업을 추가했습니다")).toBeVisible();

    await page.getByRole("button", { name: "팝업 추가" }).first().click();
    const bar = page.getByTestId("popup-editor");
    await bar.getByRole("radio", { name: "상단 띠" }).click();
    await bar.getByLabel("띠 문구").fill(BAR_TITLE);
    await bar.getByLabel("노출 페이지").selectOption("ALL");
    await expect(page.getByTestId("popup-preview")).toContainText(BAR_TITLE);
    await bar.getByRole("button", { name: "저장" }).click();
    await confirmBtn("추가").click();
    await expect(page.getByTestId("popup-row")).toHaveCount(2);
    await expect(page.getByTestId("popup-row").nth(0)).toContainText("이미지 팝업 · 가운데");
    await expect(page.getByTestId("popup-row").nth(0)).toContainText("전체 페이지");
    await expect(page.getByTestId("popup-row").nth(0)).toContainText("7일 동안 보지 않기");
    await expect(page.getByTestId("popup-row").nth(1)).toContainText("상단 띠 · 맨 위 한 줄");

    // 복제: 같은 값으로 새 팝업(숨김 상태)
    await page.getByTestId("popup-row").nth(1).getByRole("button", { name: "복제" }).click();
    const dup = page.getByTestId("popup-editor");
    await expect(dup.getByLabel("띠 문구")).toHaveValue(`${BAR_TITLE} 복사본`.slice(0, 40));
    await dup.getByRole("button", { name: "저장" }).click();
    await confirmBtn("추가").click();
    await expect(page.getByTestId("popup-row")).toHaveCount(3);
    await expect(page.getByTestId("popup-row").nth(2).getByText("숨김")).toBeVisible();
    await page.screenshot({ path: `${SHOT}/SA-065-popups-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.screenshot({ path: `${SHOT}/SA-065-popups-1024.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByTestId("popup-row")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOT}/SA-065-popups-390.png`, fullPage: true });
  });

  test("구매자 PC: 게시 중·PC 배너만, 상단 띠와 가운데 팝업, 「7일 동안 보지 않기」는 다시 열어도 안 보임", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/shop/demo-shop");
    const popup = page.getByRole("dialog", { name: POPUP_TITLE });
    await expect(popup).toBeVisible();
    expect(await imageLoaded(page, ".ep-img")).toBe(true);
    await expect(popup.getByRole("link", { name: "회원가입하기" })).toHaveAttribute("href", "/shop/demo-shop/signup");
    await expect(page.getByRole("region", { name: "알림" })).toContainText(BAR_TITLE);
    // 예약 배너는 아직 안 보이고, PC 슬라이드에 게시 중 2장(PC만 배너 포함)
    await expect(page.locator(".hb-pc .hb-slide")).toHaveCount(2);
    await expect(page.locator(".hb-pc")).toBeVisible();
    await expect(page.locator(".hb-m")).toBeHidden();
    expect(await imageLoaded(page, ".hb-pc .hb-slide img")).toBe(true);
    const pcImage = await page.locator('.hb-pc .hb-slide[aria-hidden="false"] img').first().evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { ratio: rect.width / rect.height, naturalRatio: (el as HTMLImageElement).naturalWidth / (el as HTMLImageElement).naturalHeight };
    });
    expect(pcImage.naturalRatio).toBeCloseTo(3.2, 2);
    expect(pcImage.ratio).toBeCloseTo(3.2, 2);
    // 모바일 슬라이드(숨김)의 이미지는 내려받지 않는다
    expect(await page.locator(".hb-m img").first().evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(0);
    await page.screenshot({ path: `${SHOT}/SA-064-065-shop-home-popup-1440.png` });

    await popup.getByLabel("7일 동안 보지 않기").check();
    await popup.getByRole("button", { name: "닫기" }).click();
    await expect(popup).toBeHidden();
    await page.screenshot({ path: `${SHOT}/SA-064-065-shop-home-1440.png` });
    await page.reload();
    await expect(page.locator(".hb-pc .hb-slide")).toHaveCount(2);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // 상단 띠 ×는 「오늘 하루」 기간만큼 숨긴다
    await page.getByRole("button", { name: "닫기 · 오늘 하루 보지 않기" }).click();
    await page.reload();
    await expect(page.getByRole("region", { name: "알림" })).toHaveCount(0);
  });

  test("구매자 모바일: 모바일 슬라이드(모바일 이미지, PC만 배너 제외)와 팝업, 「전체 페이지」 팝업은 가입 화면에도", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/shop/demo-shop");
    const popup = page.getByRole("dialog", { name: POPUP_TITLE });
    await expect(popup).toBeVisible();
    await page.screenshot({ path: `${SHOT}/SA-064-065-shop-home-popup-390.png` });
    await popup.getByRole("button", { name: "닫기" }).click();
    await expect(page.locator(".hb-m")).toBeVisible();
    await expect(page.locator(".hb-pc")).toBeHidden();
    await expect(page.locator(".hb-m .hb-slide")).toHaveCount(1);
    const src = await page.locator(".hb-m .hb-slide img").first().evaluate((el) => (el as HTMLImageElement).currentSrc);
    const list = await page.evaluate(async () => (await (await fetch("/api/shop/demo-shop/shop-content?page=home")).json()) as { banners: { title: string; mobileImage: { url: string } | null }[] });
    expect(src).toContain(list.banners.find((b) => b.title === "10월 스타라이트 박스 오픈")!.mobileImage!.url);
    expect(await imageLoaded(page, ".hb-m .hb-slide img")).toBe(true);
    const mobileImage = await page.locator('.hb-m .hb-slide[aria-hidden="false"] img').first().evaluate((el) => {
      const img = el as HTMLImageElement;
      const rect = img.getBoundingClientRect();
      return { ratio: rect.width / rect.height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
    });
    expect(mobileImage.naturalWidth).toBe(750);
    expect(mobileImage.naturalHeight).toBe(750);
    expect(mobileImage.ratio).toBeCloseTo(1, 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOT}/SA-064-065-shop-home-390.png` });

    await page.goto("/shop/demo-shop/signup");
    await expect(page.getByRole("dialog", { name: POPUP_TITLE })).toBeVisible();
    await expect(page.getByRole("region", { name: "알림" })).toContainText(BAR_TITLE);
  });

  test("구매자: 창 너비가 PC↔모바일 기준을 넘나들면 팝업을 다시 고른다(PC만 팝업은 좁히면 사라지고 넓히면 다시 보임)", async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
    await ctx.post("/api/seller/auth/login", { data: { email: "demo-owner@example.com", password: PASSWORD } });
    const res = await ctx.post("/api/seller/shop-content/popups", { data: { kind: "TEXT", title: "PC 전용 안내", body: "PC에서만 보여요", target: "HOME", showOnMobile: false, dismissDays: 0 } });
    expect(res.status()).toBe(201);
    const id = ((await res.json()) as { popup: { id: string } }).popup.id;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/shop/demo-shop");
      await page.getByRole("dialog", { name: POPUP_TITLE }).getByRole("button", { name: "닫기" }).click();
      const pcOnly = page.getByRole("dialog", { name: "PC 전용 안내" });
      await expect(pcOnly).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(pcOnly).toBeHidden();
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(pcOnly).toBeVisible();
      // 이미 닫은 팝업은 너비가 바뀌어도 되살아나지 않는다
      await expect(page.getByRole("dialog", { name: POPUP_TITLE })).toHaveCount(0);
    } finally {
      await ctx.delete(`/api/seller/shop-content/popups/${id}`);
      await ctx.dispose();
    }
  });

  test("「쇼핑몰 설정」 권한 없는 직원: 목록은 보고, 추가·수정·삭제는 없음", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/seller/login?next=%2Fseller%2Fbanners");
    await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
    await expect(page).toHaveURL(/\/seller\/banners$/);
    await expect(page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "홈 배너" })).toBeVisible();
    await expect(page.getByText("목록만 볼 수 있습니다. 배너 추가 · 수정은 대표자나 쇼핑몰 설정 권한이 있는 직원에게 요청해 주십시오.")).toBeVisible();
    await expect(page.getByTestId("banner-row")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "배너 추가" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "수정" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "삭제" })).toHaveCount(0);
    expect(await imageLoaded(page, ".sc-thumb-sm")).toBe(true);
    // 화면을 거치지 않고 바꾸려 해도 403
    const status = await page.evaluate(async () => (await fetch("/api/seller/shop-content/popups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "TEXT", title: "x", body: "y" }) })).status);
    expect(status).toBe(403);
    await page.screenshot({ path: `${SHOT}/SA-064-staff-readonly-1440.png` });
    await page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "이벤트 팝업", exact: true }).click();
    await expect(page.getByTestId("popup-row")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "팝업 추가" })).toHaveCount(0);
  });
});
