import { expect, test, type Page } from "@playwright/test";
import { clearReviewsInDb, deliveredItemInDb } from "./reviewDb";
import { submitSellerLogin } from "./sellerLogin";
import { okConfirm } from "./shopConfirm";

// SH-029 리뷰 쓰기 · 내 리뷰, SA-048 리뷰 관리. 운영 빌드 + 데모 시드(demo-owner·demo-buyer1, 비밀번호 E2E_PASSWORD).
// 시작·끝에 데모 쇼핑몰의 리뷰와 이 시험이 만든 주문을 테스트 DB에서 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const SHOT = "tests/e2e/screenshots";
let itemId = "";

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await clearReviewsInDb(SLUG);
  itemId = await deliveredItemInDb(SLUG, "demo-buyer1@example.com");
});
test.afterAll(() => clearReviewsInDb(SLUG));

async function buyerLogin(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
async function shots(page: Page, name: string) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOT}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

// 브라우저 canvas로 만든 큰 JPEG(2400×1800)에 위치 정보가 든 EXIF(APP1)를 끼워 넣는다(휴대폰 사진 흉내)
async function phonePhoto(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 2400;
    c.height = 1800;
    const g = c.getContext("2d")!;
    g.fillStyle = "#3b5bdb";
    g.fillRect(0, 0, 2400, 1800);
    g.fillStyle = "#fff";
    g.font = "bold 240px sans-serif";
    g.fillText("CARD", 700, 1000);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  });
  const jpeg = Buffer.from(b64, "base64");
  const payload = Buffer.from("Exif\0\0GPSLatitude 37.5665 GPSLongitude 126.9780", "latin1");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, payload, jpeg.subarray(2)]);
}

test.describe.serial("SH-029 리뷰 쓰기 · SA-048 리뷰 관리", () => {
  test("구매자: 리뷰를 기다리는 상품 → 별점·사진·글 → 올리기. 사진은 화면에서 1600px JPEG로 다시 저장돼 위치 정보 없이 올라간다", async ({ page, baseURL }) => {
    await buyerLogin(page, baseURL!);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/shop/${SLUG}/reviews`);
    await expect(page.getByRole("heading", { name: "내 리뷰" })).toBeVisible();
    await page.getByRole("link", { name: "리뷰 쓰기" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/reviews/write\\?item=${itemId}$`));
    await expect(page.getByRole("button", { name: "리뷰 올리기" })).toBeDisabled();
    await page.getByRole("radio", { name: "5점" }).click();
    await expect(page.getByText("아주 좋아요")).toBeVisible();
    await expect(page.getByText("JPG·PNG·WEBP, 한 장에 5MB까지 올릴 수 있어요")).toBeVisible();
    await expect(page.getByLabel("리뷰 사진")).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");

    const original = await phonePhoto(page);
    expect(original.includes(Buffer.from("GPSLatitude"))).toBe(true);
    // Blob 본문은 Playwright 요청 기록에 담기지 않아, 화면의 fetch를 감싸 실제로 보낸 바이트를 남긴다
    await page.evaluate((path) => {
      const w = window as unknown as { __sent?: Promise<number[]> };
      const orig = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (String(input).endsWith(path) && init?.body instanceof Blob) w.__sent = init.body.arrayBuffer().then((b) => Array.from(new Uint8Array(b)));
        return orig(input, init);
      };
    }, `/api/shop/${SLUG}/reviews/images`);
    await page.getByLabel("리뷰 사진").setInputFiles({ name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: original });
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __sent?: unknown }).__sent))).toBe(true);
    const sent = Buffer.from(await page.evaluate(() => (window as unknown as { __sent: Promise<number[]> }).__sent));
    // 보낸 바이트: JPEG, 위치 정보 없음, 긴 변 1600px 이하(SOF에서 크기 읽기)
    expect(sent.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
    expect(sent.includes(Buffer.from("GPSLatitude"))).toBe(false);
    expect(sent.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(false);
    const sof = sent.indexOf(Buffer.from([0xff, 0xc0]));
    expect(Math.max(sent.readUInt16BE(sof + 5), sent.readUInt16BE(sof + 7))).toBe(1600);
    await expect(page.locator(".rv-photo img")).toHaveCount(1);

    await page.getByRole("textbox", { name: "리뷰" }).fill("짧아요");
    await expect(page.getByText("10자 이상 써야 올릴 수 있어요")).toBeVisible();
    await page.getByRole("textbox", { name: "리뷰" }).fill("브레이크 때 뽑힌 카드 상태가 정말 좋았어요. 포장도 꼼꼼했어요.");
    await shots(page, "sh029-write");
    await page.getByRole("button", { name: "리뷰 올리기" }).click();
    await okConfirm(page, "올리기");
    await expect(page.locator("p.msg")).toContainText("리뷰를 올렸어요");
    await page.getByRole("link", { name: "내 리뷰 보기" }).click();
    const mine = page.getByTestId("my-review").first();
    await expect(mine).toContainText("공개");
    await expect(mine).toContainText("사진 1장");
  });

  test("대표자: 리뷰 목록·집계 → 상세에서 답글 저장 → 사유를 골라 숨기기", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/seller/login?next=${encodeURIComponent("/seller/reviews")}`);
    await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
    await expect(page).toHaveURL(/\/seller\/reviews$/);
    await expect(page.getByRole("link", { name: "상품 리뷰", exact: true })).toHaveClass(/on/);
    const row = page.getByTestId("review-row").first();
    await expect(row).toContainText("브레이크 때 뽑힌 카드");
    await shots(page, "sa048-list");
    await row.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.locator(".rv-imgs img")).toHaveCount(1);
    await dlg.getByRole("textbox", { name: "답글" }).fill("소중한 리뷰 감사합니다. 다음 방송에서도 좋은 카드로 찾아뵙겠습니다.");
    await dlg.getByRole("button", { name: "답글 저장" }).click();
    await expect(page.getByText("답글을 저장했습니다")).toBeVisible();
    await page.screenshot({ path: `${SHOT}/sa048-detail-1440.png` });
    await dlg.getByRole("button", { name: "숨기기" }).click();
    await expect(dlg.getByText("이 리뷰를 숨기시겠습니까?")).toBeVisible();
    await dlg.getByRole("button", { name: "상품과 무관한 내용" }).click();
    await dlg.getByRole("button", { name: "숨기기" }).last().click();
    await expect(page.getByText("리뷰를 숨겼습니다")).toBeVisible();
    await dlg.getByRole("button", { name: "닫기" }).click();
    await expect(page.getByTestId("review-row").first()).toContainText("숨김");
  });

  test("구매자: 내 리뷰에서 판매자 답글과 숨김 사유를 본다", async ({ page, baseURL }) => {
    await buyerLogin(page, baseURL!);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/shop/${SLUG}/reviews`);
    const mine = page.getByTestId("my-review").first();
    await expect(mine).toContainText("숨김");
    await expect(mine).toContainText("이 리뷰는 판매자가 숨겼어요.");
    await expect(mine).toContainText("상품과 관계없는 내용이에요");
    await expect(mine).toContainText("소중한 리뷰 감사합니다");
    await page.screenshot({ path: `${SHOT}/sh029-mine-390.png`, fullPage: true });
  });

  test("공통 모달: 오른쪽 위에 X가 보이고, X·Esc·바깥 클릭으로 닫힌다(리뷰는 그대로)", async ({ page, baseURL }) => {
    await buyerLogin(page, baseURL!);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(`/shop/${SLUG}/reviews`);
      const open = async () => {
        await page.getByTestId("my-review").first().getByRole("button", { name: "지우기" }).click();
        const dlg = page.getByRole("dialog", { name: "리뷰를 지울까요?" });
        await expect(dlg).toBeVisible();
        return dlg;
      };
      let dlg = await open();
      const x = dlg.getByRole("button", { name: "닫기" });
      await expect(x).toBeVisible();
      expect(await dlg.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("16px"); // 모달 모서리 16px(2026-10-05 시각 규격, 이전 8px)
      const [box, xb] = [await dlg.boundingBox(), await x.boundingBox()];
      expect(xb!.x + xb!.width).toBeGreaterThan(box!.x + box!.width - 24);
      expect(xb!.y).toBeLessThan(box!.y + 24);
      await page.screenshot({ path: `${SHOT}/shop-modal-x-${width}.png` });
      await x.click();
      await expect(dlg).toBeHidden();
      dlg = await open();
      await page.keyboard.press("Escape");
      await expect(dlg).toBeHidden();
      dlg = await open();
      await page.mouse.click(4, 4);
      await expect(dlg).toBeHidden();
      await expect(page.getByTestId("my-review")).toHaveCount(1);
    }
  });

  test("공통 모달: 지우는 중에는 X·Esc·바깥 클릭이 막히고 안내가 보이며, 지우기는 한 번만 보낸다", async ({ page, baseURL }) => {
    await buyerLogin(page, baseURL!);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/shop/${SLUG}/reviews`);
    let deletes = 0;
    await page.route(`**/api/shop/${SLUG}/reviews/*`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      deletes += 1;
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.getByTestId("my-review").first().getByRole("button", { name: "지우기" }).click();
    const dlg = page.getByRole("dialog", { name: "리뷰를 지울까요?" });
    await dlg.getByRole("button", { name: "지우기" }).click();
    await expect(dlg.getByRole("status")).toContainText("처리하고 있어요");
    await expect(dlg.getByRole("button", { name: "닫기" })).toBeDisabled();
    await expect(dlg.getByRole("button", { name: "지우기" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.mouse.click(4, 4);
    await expect(dlg).toBeVisible();
    await expect(dlg).toBeHidden({ timeout: 10_000 });
    expect(deletes).toBe(1);
  });
});
