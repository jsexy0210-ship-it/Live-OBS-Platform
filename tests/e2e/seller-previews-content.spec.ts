import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 파트너스 관리자 미리보기: 저장 전 입력값 하나에서 구매자가 보는 모든 필드를 그린다(배너·팝업·쿠폰).
// 저장하지 않으므로 데모 데이터를 바꾸지 않는다. 입력을 지우거나 구매자 컴포넌트 재사용을 빼면 실패한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function ownerOpen(page: Page, path: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(path)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

async function canvasPng(page: Page, w: number, h: number, color: string): Promise<Buffer> {
  const b64 = await page.evaluate(
    ([cw, ch, c]) => {
      const cv = document.createElement("canvas");
      cv.width = cw as number;
      cv.height = ch as number;
      const g = cv.getContext("2d")!;
      g.fillStyle = c as string;
      g.fillRect(0, 0, cv.width, cv.height);
      return cv.toDataURL("image/png").split(",")[1];
    },
    [w, h, color],
  );
  return Buffer.from(b64, "base64");
}
const file = (name: string, buffer: Buffer) => ({ name, mimeType: "image/png", buffer });

test.describe("파트너스 미리보기: 입력 → 즉시 반영", () => {
  test("배너: 제목·링크·모바일 이미지·표시 기기가 구매자 배너 모양으로 바로 바뀐다", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ownerOpen(page, "/seller/banners");
    await page.getByRole("button", { name: "배너 추가" }).first().click();
    const ed = page.getByTestId("banner-editor");
    await ed.getByRole("button", { name: "미리보기" }).click();
    const pv = ed.getByTestId("banner-preview");
    await expect(pv).toContainText("이미지를 올리면 여기에 표시됩니다");

    await ed.getByLabel("PC 이미지", { exact: true }).setInputFiles(file("pc.png", await canvasPng(page, 1920, 600, "#5b3df6")));
    await ed.getByLabel("제목 (대체 텍스트)").fill("미리보기 제목");
    await expect(pv.locator("img")).toHaveAttribute("alt", "미리보기 제목");
    await expect(pv.locator("a")).toHaveCount(0);

    await ed.getByLabel("연결", { exact: true }).selectOption("custom");
    await ed.getByLabel("연결 주소").fill("/products/abc");
    await expect(pv.locator("a")).toHaveAttribute("href", /\/shop\/[^/]+\/products\/abc$/);
    await ed.getByLabel("연결 주소").fill("https://example.com/event");
    await expect(pv.locator("a")).toHaveAttribute("href", "https://example.com/event");
    await expect(pv.locator("a")).toHaveAttribute("target", "_blank");
    // 미리보기 링크는 눌러도 이동하지 않는다
    await pv.locator("a").click();
    await expect(page).toHaveURL(/\/seller\/banners$/);
    await expect(ed).toBeVisible();

    // 모바일: 모바일 이미지를 올리면 그 이미지, 없으면 PC 이미지
    const pcSrc = await pv.locator("img").getAttribute("src");
    await ed.getByLabel("모바일 이미지", { exact: true }).setInputFiles(file("m.png", await canvasPng(page, 750, 750, "#e8382d")));
    await expect.poll(() => pv.locator("img").getAttribute("src")).not.toBe(pcSrc);

    // 표시 기기를 PC만으로 하면 모바일 미리보기는 비운다
    await ed.getByRole("radio", { name: "PC만" }).click();
    await expect(pv).toContainText("모바일에서는 표시하지 않음");
    await expect(pv.locator("img")).toHaveCount(0);
  });

  test("팝업: 형태별로 제목·내용·링크·버튼 이름·보지 않기가 구매자 팝업 모양으로 바로 바뀐다", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ownerOpen(page, "/seller/banners/popups");
    await page.getByRole("button", { name: "팝업 추가" }).first().click();
    const dialog = page.getByRole("dialog", { name: "팝업 추가" });
    const pv = dialog.getByTestId("popup-preview");

    // 글 팝업
    await dialog.getByRole("radio", { name: "글 팝업" }).click();
    await dialog.getByLabel("제목", { exact: true }).fill("추석 배송 안내");
    await dialog.getByLabel("내용").fill("연휴에는 순서대로 보내요");
    await expect(pv.getByRole("heading", { name: "추석 배송 안내" })).toBeVisible();
    await expect(pv).toContainText("연휴에는 순서대로 보내요");
    await expect(pv.locator("a.btn")).toHaveCount(0);
    await dialog.getByLabel("링크").fill("/signup");
    await expect(pv.locator("a.btn")).toHaveText("자세히 보기");
    await dialog.getByLabel("버튼 이름").fill("가입하기");
    await expect(pv.locator("a.btn")).toHaveText("가입하기");
    await expect(pv.locator("a.btn")).toHaveAttribute("href", /\/shop\/[^/]+\/signup$/);
    await dialog.getByLabel("다시 보지 않기").selectOption("7");
    await expect(pv).toContainText("7일 동안 보지 않기");
    await dialog.getByLabel("다시 보지 않기").selectOption("0");
    await expect(pv).not.toContainText("보지 않기");
    await pv.locator("a.btn").click();
    await expect(page).toHaveURL(/\/seller\/banners\/popups$/);

    // 이미지 팝업: 이미지·제목(대체 글)
    await dialog.getByRole("radio", { name: "이미지 팝업" }).click();
    await dialog.getByLabel("이미지", { exact: true }).setInputFiles(file("ev.png", await canvasPng(page, 600, 600, "#ffc451")));
    await dialog.getByLabel("제목 (대체 텍스트)").fill("이벤트 이미지");
    await expect(pv.locator("img.ep-img")).toHaveAttribute("alt", "이벤트 이미지");
    await expect(pv.locator("a:has(img.ep-img)")).toHaveAttribute("href", /\/shop\/[^/]+\/signup$/);

    // 상단 띠: 문구·링크
    await dialog.getByRole("radio", { name: "상단 띠" }).click();
    await dialog.getByLabel("띠 문구").fill("배송 지연 안내");
    await expect(pv.locator(".ep-bar-text")).toHaveText("배송 지연 안내");
    await expect(pv.locator("a.ep-bar-text")).toHaveAttribute("href", /\/shop\/[^/]+\/signup$/);
  });

  test("쿠폰: 혜택·최대 할인·최소 주문·적용 범위·기한이 구매자 쿠폰함 문구로 바로 바뀐다", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ownerOpen(page, "/seller/coupons");
    await page.getByRole("button", { name: "쿠폰 만들기" }).first().click();
    const dlg = page.getByRole("dialog", { name: "쿠폰 만들기" });
    const pv = dlg.getByTestId("coupon-preview");

    await dlg.getByLabel("쿠폰 이름").fill("가을 맞이 쿠폰");
    await dlg.getByRole("radio", { name: "비율 할인" }).click();
    await dlg.getByLabel("할인율 (%)").fill("10");
    await expect(pv).toContainText("10%");
    await expect(pv).toContainText("가을 맞이 쿠폰");
    await expect(pv).toContainText("금액 조건 없음");
    await dlg.getByLabel("최대 할인 (원)").fill("3000");
    await expect(pv).toContainText("최대 3,000원 할인");
    await dlg.getByLabel("최소 주문 금액 (원)").fill("30000");
    await expect(pv).toContainText("30,000원 이상 주문");
    await dlg.getByRole("checkbox", { name: "할인 중인 상품 제외" }).check();
    await expect(pv).toContainText("할인 중 상품 제외");
    await dlg.getByRole("checkbox", { name: /받은 날부터/ }).check();
    await dlg.getByLabel("받은 뒤 쓸 수 있는 날 수").fill("7");
    await expect(pv).toContainText("받은 날부터 7일");
    await dlg.getByRole("radio", { name: "배송비 무료" }).click();
    await expect(pv).toContainText("배송비 무료");
    await expect(pv).not.toContainText("최대");
  });
});
