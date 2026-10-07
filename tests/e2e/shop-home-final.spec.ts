import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hash } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const db = new PrismaClient();
const suffix = randomBytes(5).toString("hex");
const slug = `home-final-${suffix}`;
const loginId = `home-${suffix}@example.test`;
const password = randomBytes(20).toString("hex");
const evidence = "tests/e2e/screenshots/shop-home-final";
let sellerId: string, buyerId: string, sessionId: string;
let productIds: string[] = [];
const names = ["스타라이트 부스터 박스", "문라이트 컬렉션 박스", "피닉스 케이스 브레이크", "크리스탈 팩"];

test.beforeAll(async () => {
  mkdirSync(evidence, { recursive: true });
  const seller = await db.seller.create({ data: { slug, shopName: "카드마켓", status: "ACTIVE", approvedAt: new Date(), trialEndsAt: new Date(Date.now() + 10 * 86400000), shopTopNotice: "무통장 입금은 입금자명을 방송 닉네임과 같게 적어 주세요" } });
  sellerId = seller.id;
  const grade = await db.memberGrade.create({ data: { sellerId, displayName: "일반", sortOrder: 0 } });
  const buyer = await db.buyerMember.create({ data: { sellerId, gradeId: grade.id, loginId, passwordHash: await hash(password), name: "홈 검수", phone: "01000000000", ciHash: suffix, identityVerifiedAt: new Date(), birthDate: new Date("1990-01-01"), broadcastNickname: "별빛사냥꾼" } });
  buyerId = buyer.id;
  const session = await db.broadcastSession.create({ data: { sellerId, title: "스타라이트 부스터 개봉" } });
  sessionId = session.id;
  for (let i = 0; i < names.length; i++) {
    const p = await db.product.create({ data: { sellerId, name: names[i], price: [99000, 150000, 198000, 5000][i], status: i === 3 ? "SOLD_OUT" : "ON_SALE", sortOrder: i } });
    productIds.push(p.id);
    const option = await db.productOption.create({ data: { sellerId, productId: p.id, name: "기본", stock: i === 3 ? 0 : 10 } });
    const order = await db.order.create({ data: { sellerId, buyerMemberId: buyerId, orderNo: i + 1, broadcastNicknameSnapshot: "별빛사냥꾼", totalAmount: p.price, status: "PAID" } });
    const item = await db.orderItem.create({ data: { sellerId, orderId: order.id, productId: p.id, optionId: option.id, productNameSnapshot: p.name, optionNameSnapshot: "기본", unitPrice: p.price, quantity: 1 } });
    await db.queueItem.create({ data: { sellerId, orderId: order.id, orderItemId: item.id, broadcastSessionId: sessionId, position: i, receivedAt: new Date(), nicknameSnapshot: "별빛사냥꾼", productLabel: p.name, quantity: 1 } });
    await db.shopDisplayItem.create({ data: { sellerId, productId: p.id, sortOrder: i } });
  }
  for (const [i, kind] of (["LIVE", "RECOMMENDED", "NEW"] as const).entries()) await db.shopDisplaySection.create({ data: { sellerId, kind, title: ["방송 중 상품", "추천 상품", "신상품"][i], itemCount: 4, sortOrder: i } });
  await db.shopNotice.createMany({ data: ["개천절 연휴 배송 안내", "방송 주문 개봉 영상은 유튜브 다시보기에서 볼 수 있어요"].map((title, i) => ({ sellerId, kind: "NOTICE", title, body: title, isPublished: true, isPinned: i === 0 })) });
  await db.shopLegalNotice.create({ data: { sellerId, address: "검수용 주소 <b>3층</b>", csPhone: "02-0000-0000", csHours: "평일 13:00~18:00", kakaoChannelUrl: "https://pf.kakao.com/_test", youtubeChannelUrl: "https://www.youtube.com/@test" } });
});

test.afterAll(async () => {
  if (process.env.ONQ_HOME_FIXTURE_FILE) writeFileSync(process.env.ONQ_HOME_FIXTURE_FILE, JSON.stringify({ sellerId, slug, buyerId, sessionId, productIds, createdBy: "shop-home-final" }));
  else if (sellerId) {
    const where = { sellerId };
    await db.buyerSession.deleteMany({ where }); await db.cartItem.deleteMany({ where }); await db.wishItem.deleteMany({ where });
    await db.queueItem.deleteMany({ where }); await db.hitCard.deleteMany({ where }); await db.orderItem.deleteMany({ where }); await db.order.deleteMany({ where });
    await db.broadcastSession.deleteMany({ where }); await db.shopNotice.deleteMany({ where }); await db.shopLegalNotice.deleteMany({ where });
    await db.shopDisplayItem.deleteMany({ where }); await db.shopDisplaySection.deleteMany({ where }); await db.productOption.deleteMany({ where }); await db.product.deleteMany({ where });
    await db.buyerMember.deleteMany({ where }); await db.memberGrade.deleteMany({ where });
    await db.seller.delete({ where: { id: sellerId } });
  }
  await db.$disconnect();
});

test("홈: 실제 진열 순서·카드·공지·채널과 3폭 안전성", async ({ page }) => {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/shop/${slug}`);
    await expect(page.locator(".shop-home-products h2")).toHaveText(["방송 중 상품", "추천 상품", "신상품"]);
    await expect(page.locator(".shop-home-kind-recommended .pc-name")).toHaveText(names);
    await expect(page.locator(".shop-home-hero b")).toHaveText("스타라이트 부스터 개봉");
    await expect(page.locator(".live-bar")).toBeVisible();
    const menu = page.locator(width === 390 ? ".shop-mcat" : ".shop-cats");
    await expect(menu.getByRole("link", { name:"인기 카드",exact:true })).toHaveAttribute("href",`/shop/${slug}`);
    await expect(menu.getByRole("link", { name:"공지 · 이용안내",exact:true })).toHaveAttribute("href",`/shop/${slug}/help`);
    await expect(page.getByRole("link", { name: "카카오톡 문의", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "▶ 유튜브 채널", exact: true })).toBeVisible();
    await expect(page.getByLabel("상단 공지", { exact: true })).toBeVisible();
    await expect(page.locator(".shop-foot-info")).toContainText("검수용 주소 <b>3층</b>");
    await expect(page.locator(".shop-foot-info b")).toHaveCount(0);
    const geometry = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, columns: getComputedStyle(document.querySelector(".shop-home .pc-grid")!).gridTemplateColumns.split(" ").length, headings: [...document.querySelectorAll(".shop-home h2")].map(n => n.textContent), noticeHeight: document.querySelector(".shop-top-notice")!.getBoundingClientRect().height, heroHeight: document.querySelector(".shop-home-hero")!.getBoundingClientRect().height, homeNoticeAfterHero: document.querySelector(".shop-ntc")!.getBoundingClientRect().top >= document.querySelector(".shop-home-banner")!.getBoundingClientRect().bottom }));
    expect(geometry.overflow).toBe(false);
    expect(geometry.columns).toBe(width >= 1024 ? 4 : 2);
    expect(geometry.noticeHeight).toBe(32);
    expect(geometry.heroHeight).toBe(width === 390 ? 200 : 360);
    expect(geometry.homeNoticeAfterHero).toBe(width === 390);
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const head = rect(".shop-top"), live = rect(".live-bar"), category = rect(innerWidth < 768 ? ".shop-mcat" : ".shop-cats");
      const tables = rect(".shop-home-tables"), notices = rect(".shop-home-notices");
      return { liveOrder: innerWidth < 768 ? head.bottom <= live.top && live.bottom <= category.top : category.bottom <= live.top, tableWidth: tables.width, noticeWidth: notices.width, noticeRight: notices.right, tableRight: tables.right, noticeCells: document.querySelector(".shop-home-notices tr")!.children.length };
    });
    expect(layout.liveOrder).toBe(true);
    expect(layout.noticeCells).toBe(2);
    if (width >= 1024) {
      expect(layout.noticeWidth).toBeCloseTo((layout.tableWidth - 24) / 2, 0);
      expect(layout.noticeRight).toBeCloseTo(layout.tableRight, 0);
    }
    writeFileSync(`${evidence}/app-${width}.json`, JSON.stringify({ ...geometry, ...layout }));
    await page.screenshot({ path: `${evidence}/app-${width}.png`, fullPage: true });
  }
});

test("홈 카드: 로그인 경계·찜·담기·선택 상품 바로 구매", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${slug}`);
  const card = page.locator(".shop-home-kind-recommended .pc").first();
  await card.getByRole("button", { name: "담기", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  const login = await page.request.post(`/api/shop/${slug}/auth/login`, { data: { loginId, password }, headers: { origin: baseURL! } });
  expect(login.ok()).toBe(true);
  await page.goto(`/shop/${slug}`);
  await card.getByRole("button", { name: "찜", exact: true }).click();
  await expect(card.getByRole("button", { name: "찜 취소" })).toBeVisible();
  const repeated = page.locator(".shop-home .pc").filter({ has: page.locator(`a[href$="/${productIds[0]}"]`) });
  await expect(repeated.getByRole("button", { name: "찜 취소" })).toHaveCount(3);
  const added = await repeated.getByRole("button", { name: "찜 취소" }).count();
  await page.screenshot({ path: `${evidence}/wishlist-added-1440.png`, fullPage: true });
  await repeated.last().getByRole("button", { name: "찜 취소" }).click();
  await expect(repeated.getByRole("button", { name: "찜", exact: true })).toHaveCount(3);
  writeFileSync(`${evidence}/wishlist-state.json`, JSON.stringify({ repeatedCards: await repeated.count(), added, removed: await repeated.getByRole("button", { name: "찜", exact: true }).count() }));
  await card.getByRole("button", { name: "담기", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("장바구니에 담았어요");
  const count = await page.request.get(`/api/shop/${slug}/cart/count`);
  expect((await count.json()).count).toBe(1);
  await card.getByRole("button", { name: "바로 구매", exact: true }).click();
  await expect(page).toHaveURL(/\/checkout\?ids=/);
});

test("홈: 판매자 진열 숨김과 구독 만료 차단", async ({ page }) => {
  await db.shopDisplaySection.updateMany({ where: { sellerId, kind: "NEW" }, data: { visible: false } });
  try { await page.goto(`/shop/${slug}`); await expect(page.locator(".shop-home-kind-new")).toHaveCount(0); }
  finally { await db.shopDisplaySection.updateMany({ where: { sellerId, kind: "NEW" }, data: { visible: true } }); }
  await db.seller.update({ where: { id: sellerId }, data: { trialEndsAt: new Date(0) } });
  try { await page.goto(`/shop/${slug}`); await expect(page.locator(".shop-home")).toHaveCount(0); }
  finally { await db.seller.update({ where: { id: sellerId }, data: { trialEndsAt: new Date(Date.now() + 10 * 86400000) } }); }
});

test("방송 종료 홈: LIVE 띠 숨김과 최근 방송 상품 유지", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await db.broadcastSession.update({ where: { id: sessionId }, data: { status: "ENDED", endedAt: new Date() } });
  try {
    await page.goto(`/shop/${slug}`);
    await expect(page.locator(".live-bar")).toHaveCount(0);
    await expect(page.locator(".shop-home-kind-live h2")).toHaveText("최근 방송 상품");
    await expect(page.getByRole("link", { name: "방송 시작 알림 받기" })).toHaveAttribute("href", `/shop/${slug}/me/notifications`);
    await page.screenshot({ path: `${evidence}/ended-1440.png`, fullPage: true });
  } finally { await db.broadcastSession.update({ where: { id: sessionId }, data: { status: "LIVE", endedAt: null } }); }
});

test("공통 머리: 비홈 3폭 LIVE 순서와 상세 56·일반 52·조작44 보존", async ({ page }) => {
  const results = [];
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["products", "help", "terms", `products/${productIds[0]}`]) {
      await page.goto(`/shop/${slug}/${route}`);
      await expect(page.locator(".live-bar")).toBeVisible();
      await expect(page.getByLabel("상단 공지", { exact: true })).toBeVisible();
      const detail = route.includes("/");
      const geometry = await page.evaluate(({ detail }) => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const head = rect(innerWidth < 768 && detail ? ".shop-product-header" : ".shop-top");
        const live = rect(".live-bar"), category = rect(innerWidth < 768 ? ".shop-mcat" : ".shop-cats");
        return { width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,headHeight:head.height,liveOrder:innerWidth<768?head.bottom<=live.top&&(detail||live.bottom<=category.top):category.bottom<=live.top };
      }, { detail });
      expect(geometry.overflow).toBe(false);
      expect(geometry.liveOrder).toBe(true);
      if (width === 390) {
        expect(geometry.headHeight).toBe(detail ? 56 : 52);
        const button = detail ? page.getByRole("button", { name: "목록 화면으로" }) : page.getByRole("button", { name: "카테고리 메뉴" });
        await expect(button).toHaveCSS("width", "44px");
        await expect(button).toHaveCSS("height", "44px");
      }
      results.push({ route:detail?"product-detail":route,...geometry });
      if (route === "products" || width === 390 && detail) await page.screenshot({ path:`${evidence}/nonhome-${detail?"detail":route}-${width}.png`,fullPage:true });
    }
  }
  writeFileSync(`${evidence}/nonhome-layout.json`,JSON.stringify(results));
  const longName = "가나다라마바사아자차카타파하가나다라마바";
  await db.seller.update({ where:{id:sellerId},data:{shopName:longName} });
  try {
    await page.setViewportSize({width:390,height:900});
    await page.goto(`/shop/${slug}`);
    await expect(page.locator(".shop-top .shop-name")).toHaveText(longName);
    const nameSafety = await page.evaluate(() => {
      const name=document.querySelector(".shop-top .shop-name")!,n=name.getBoundingClientRect(),h=document.querySelector(".shop-top")!.getBoundingClientRect();
      const overlap=[...document.querySelectorAll(".shop-top .shop-iconbtn")].some(e=>{const r=e.getBoundingClientRect();return r.width>0&&n.left<r.right&&n.right>r.left&&n.top<r.bottom&&n.bottom>r.top;});
      return {fullText:name.scrollWidth<=name.clientWidth&&n.top>=h.top&&n.bottom<=h.bottom,overlap};
    });
    expect(nameSafety).toEqual({fullText:true,overlap:false});
    writeFileSync(`${evidence}/long-name-safety.json`,JSON.stringify(nameSafety));
    await page.screenshot({path:`${evidence}/long-name-390.png`,fullPage:true});
  } finally {await db.seller.update({where:{id:sellerId},data:{shopName:"카드마켓"}});}
});

test("FINAL 원본 구조 증거: 실앱 캡처와 구분", async ({ page }) => {
  for (const [width, file] of [[1440, "SH-001-PC-IA.dc.html"], [390, "SH-001-IA.dc.html"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(readFileSync(`design/project/${file}`, "utf8").replace(/<link[^>]+>/g, "").replace(/<script[\s\S]*?<\/script>/g, ""));
    await page.addStyleTag({ content: readFileSync("design/project/ds/wds/tokens.css", "utf8") });
    await page.addStyleTag({ content: readFileSync("design/project/lop.css", "utf8") });
    const source = page.locator(".sh24").first();
    writeFileSync(`${evidence}/source-${width}.json`, JSON.stringify(await source.locator("h2").allTextContents()));
    await source.screenshot({ path: `${evidence}/source-${width}.png` });
  }
});
