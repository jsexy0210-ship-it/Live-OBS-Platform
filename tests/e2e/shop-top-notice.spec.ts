import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { SHOP_NAME_MAX } from "../../lib/server/seller-settings/shopProfile";

// SH-001 FINAL v322: 실제 공개 쇼핑몰과 정본의 계산 규격을 따로 검증한다.
const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
const slug = `notice-${randomBytes(6).toString("hex")}`;
const notice = "무통장 입금은 입금자명을 방송 닉네임과 같게 적어 주세요";
let sellerId: string | undefined;
const evidence = "tests/e2e/screenshots/shop-top-notice";

test.beforeAll(async () => {
  mkdirSync(evidence, { recursive: true });
  const seller = await db.seller.create({ data: { slug, shopName: "상단 공지 검증", status: "ACTIVE", approvedAt: new Date(), trialEndsAt: new Date(Date.now() + 10 * 86_400_000), shopTopNotice: notice } });
  sellerId = seller.id;
});
test.afterAll(async () => {
  if (sellerId) {
    if (process.env.ONQ_SH_NOTICE_FIXTURE_FILE) {
      const file = process.env.ONQ_SH_NOTICE_FIXTURE_FILE;
      let prior: unknown[] = [];
      try { const value = JSON.parse(readFileSync(file, "utf8")); prior = Array.isArray(value) ? value : [value]; } catch { /* 첫 실행 */ }
      writeFileSync(file, JSON.stringify([...prior, { sellerId, slug, createdBy: "sh001-top-notice", createdAt: new Date().toISOString() }]));
    } else await db.seller.delete({ where: { id: sellerId } });
  }
  await db.$disconnect();
});

test("FINAL v322 상단 공지 계산 규격: PC와 휴대폰", async ({ page }) => {
  for (const [width, file] of [[1440, "SH-001-PC-IA.dc.html"], [390, "SH-001-IA.dc.html"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(readFileSync(`design/project/${file}`, "utf8").replace(/<link[^>]+>/g, "").replace(/<script[\s\S]*?<\/script>/g, ""));
    await page.addStyleTag({ content: readFileSync("design/project/ds/wds/tokens.css", "utf8") });
    await page.addStyleTag({ content: readFileSync("design/project/lop.css", "utf8") });
    const bar = page.locator(".topn").first();
    const css = await bar.evaluate(el => { const c = getComputedStyle(el); return { height: el.getBoundingClientRect().height, color: c.color, background: c.backgroundColor, fontSize: c.fontSize, whiteSpace: c.whiteSpace, textOverflow: c.textOverflow }; });
    expect(css).toEqual({ height: 32, color: "rgb(255, 255, 255)", background: "rgb(34, 34, 34)", fontSize: "12px", whiteSpace: "nowrap", textOverflow: "ellipsis" });
    await expect(bar.locator("a,button")).toHaveCount(0);
    if (width === 1440) {
      expect(await page.locator(".hd .in").first().evaluate(el => getComputedStyle(el).gap)).toBe("24px");
      expect(await page.locator(".hd .ic").first().evaluate(el => getComputedStyle(el).gap)).toBe("24px");
      expect(await page.locator(".srch input").first().evaluate(el => getComputedStyle(el).fontSize)).toBe("13px");
    } else {
      expect(await page.locator(".mh").first().evaluate(el => ({ height: el.getBoundingClientRect().height, paddingLeft: getComputedStyle(el).paddingLeft, paddingRight: getComputedStyle(el).paddingRight }))).toEqual({ height: 52, paddingLeft: "16px", paddingRight: "16px" });
    }
    writeFileSync(`${evidence}/source-${width}.json`, JSON.stringify(css));
    await bar.screenshot({ path: `${evidence}/source-${width}.png` });
  }
});

test("실앱: 공지는 3폭 최상단 32px 한 줄이며 다른 쇼핑몰 화면에도 유지", async ({ page }) => {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/shop/${slug}`);
    await expect(page.getByText("지금은 쇼핑몰을 이용할 수 없어요", { exact: true })).toHaveCount(0);
    const bar = page.getByLabel("상단 공지", { exact: true });
    await expect(bar).toHaveText(notice);
    const css = await bar.evaluate(el => { const c = getComputedStyle(el), text = getComputedStyle(el.firstElementChild!); return { top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height, color: c.color, background: c.backgroundColor, fontSize: c.fontSize, whiteSpace: text.whiteSpace, textOverflow: text.textOverflow, overflow: document.documentElement.scrollWidth > innerWidth }; });
    expect(css).toEqual({ top: 0, height: 32, color: "rgb(255, 255, 255)", background: "rgb(34, 34, 34)", fontSize: "12px", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: false });
    await expect(bar.locator("a,button")).toHaveCount(0);
    if (width >= 768) {
      expect(await page.locator(".shop-top .shop-wrap").evaluate(el => getComputedStyle(el).gap)).toBe("24px");
      expect(await page.locator(".shop-hics").evaluate(el => getComputedStyle(el).gap)).toBe("24px");
      expect(await page.locator(".shop-search input").evaluate(el => getComputedStyle(el).fontSize)).toBe("13px");
    } else {
      expect(await page.locator(".shop-top .shop-wrap").evaluate(el => ({ height: el.getBoundingClientRect().height, paddingLeft: getComputedStyle(el).paddingLeft, paddingRight: getComputedStyle(el).paddingRight }))).toEqual({ height: 52, paddingLeft: "16px", paddingRight: "16px" });
      const hits = await page.locator(".shop-top .shop-iconbtn:visible").evaluateAll(els => els.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
      expect(hits).toHaveLength(3);
      for (const hit of hits) { expect(hit.width).toBeGreaterThanOrEqual(44); expect(hit.height).toBeGreaterThanOrEqual(44); }
    }
    writeFileSync(`${evidence}/app-${width}.json`, JSON.stringify(css));
    await page.screenshot({ path: `${evidence}/app-${width}.png` });
  }
  for (const path of ["products", "help", "login", "terms"]) {
    await page.goto(`/shop/${slug}/${path}`);
    await expect(page.getByLabel("상단 공지", { exact: true })).toHaveText(notice);
  }
});

test("실앱: 공백은 숨김, 긴 글은 말줄임, HTML은 문자로 표시", async ({ page }) => {
  for (const value of [null, "   "]) {
    await db.seller.update({ where: { id: sellerId! }, data: { shopTopNotice: value } });
    await page.goto(`/shop/${slug}`);
    await expect(page.getByLabel("상단 공지", { exact: true })).toHaveCount(0);
  }
  const value = `<script>window.noticeInjected=true</script>${"긴 공지".repeat(30)}`;
  await db.seller.update({ where: { id: sellerId! }, data: { shopTopNotice: value } });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/shop/${slug}`);
  const bar = page.getByLabel("상단 공지", { exact: true });
  await expect(bar).toHaveText(value);
  await expect(bar.locator("script")).toHaveCount(0);
  expect(await bar.locator(".shop-wrap").evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => "noticeInjected" in window)).toBe(false);
  await db.seller.update({ where: { id: sellerId! }, data: { shopTopNotice: notice } });
});

test("실앱: 허용 길이 상호의 3폭 머리 경계와 휴대폰 조작 영역", async ({ page }) => {
  const name = "긴쇼핑몰".repeat(5).slice(0, SHOP_NAME_MAX);
  await db.seller.update({ where: { id: sellerId! }, data: { shopName: name } });
  try {
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/shop/${slug}`);
      await expect(page.locator(".shop-name")).toHaveText(name);
      const geometry = await page.locator(".shop-top .shop-wrap").evaluate(el => {
        const rect = el.getBoundingClientRect(), brand = el.querySelector(".shop-brand")!.getBoundingClientRect();
        const controls = [...el.querySelectorAll(".shop-iconbtn")].filter(c => getComputedStyle(c).display !== "none").map(c => { const r = c.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; });
        return { head: { top: rect.top, bottom: rect.bottom }, brand: { left: brand.left, right: brand.right, top: brand.top, bottom: brand.bottom }, controls, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      writeFileSync(`${evidence}/long-name-${width}.json`, JSON.stringify(geometry));
      await page.screenshot({ path: `${evidence}/long-name-${width}.png` });
      expect(geometry.overflow).toBe(false);
      expect(geometry.brand.top).toBeGreaterThanOrEqual(geometry.head.top);
      expect(geometry.brand.bottom).toBeLessThanOrEqual(geometry.head.bottom);
      if (width === 390) {
        expect(geometry.controls).toHaveLength(3);
        for (const c of geometry.controls) { expect(c.width).toBeGreaterThanOrEqual(44); expect(c.height).toBeGreaterThanOrEqual(44); }
        expect(geometry.brand.left).toBeGreaterThanOrEqual(geometry.controls[0].right);
        expect(geometry.brand.right).toBeLessThanOrEqual(geometry.controls[1].left);
      }
    }
  } finally {
    await db.seller.update({ where: { id: sellerId! }, data: { shopName: "상단 공지 검증" } });
  }
});
