import { expect, request, test, type Page } from "@playwright/test";
import { png } from "../unit/shopContentFixtures";
import { submitSellerLogin } from "./sellerLogin";

// 홈 배너 관리·이벤트 팝업 관리(파트너스 관리자)와 구매자 쇼핑몰 홈 표시. 실행 시작·끝에 데모 쇼핑몰의 배너·팝업을 모두 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SHOT = "tests/e2e/screenshots";

async function clearAll() {
  const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
  try {
    expect((await ctx.post("/api/seller/auth/login", { data: { email: "demo-owner@example.com", password: PASSWORD } })).ok()).toBe(true);
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

async function ownerOpen(page: Page, path: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(path)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

// 브라우저 캔버스로 만든 실제 JPEG(그림이 실제로 그려지는지까지 보려고)
async function canvasJpeg(page: Page, width: number, height: number, color: string, label: string): Promise<Buffer> {
  const b64 = await page.evaluate(
    ([w, h, c, t]) => {
      const cv = document.createElement("canvas");
      cv.width = w as number;
      cv.height = h as number;
      const g = cv.getContext("2d")!;
      g.fillStyle = c as string;
      g.fillRect(0, 0, cv.width, cv.height);
      g.fillStyle = "#fff";
      g.font = "bold 96px sans-serif";
      g.textAlign = "center";
      g.fillText(t as string, cv.width / 2, cv.height / 2);
      return cv.toDataURL("image/jpeg", 0.85).split(",")[1];
    },
    [width, height, color, label],
  );
  return Buffer.from(b64, "base64");
}

const file = (name: string, buffer: Buffer, mimeType = "image/png") => ({ name, mimeType, buffer });
const imageLoaded = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0);

// 지금 KST 기준 datetime-local 값(분 단위)
const kstLocal = (ms: number) => new Date(Date.now() + ms + 9 * 3600_000).toISOString().slice(0, 16);

test.describe.serial("홈 배너·이벤트 팝업", () => {
  test("대표자: 배너 추가(링크 검사·미리보기) → 예약 배너 추가 → 끌어서 순서 변경", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ownerOpen(page, "/seller/banners");
    await expect(page.getByRole("link", { name: "홈 배너 관리" })).toBeVisible();
    await expect(page.getByRole("link", { name: "이벤트 팝업 관리" })).toBeVisible();
    await expect(page.getByText("등록된 배너 없음")).toBeVisible();

    await page.getByRole("button", { name: "배너 추가" }).first().click();
    const dialog = page.getByRole("dialog", { name: "배너 추가" });
    await dialog.getByLabel("배너 이름").fill("10월 스타라이트 박스 오픈");
    await dialog.getByLabel("PC 이미지").setInputFiles(file("pc.png", png(1920, 600, [91, 61, 246])));
    await expect(dialog.getByText("1920 × 600px")).toBeVisible();
    // 이미지가 아닌 파일(SVG)은 내용으로 걸러진다
    await dialog.getByLabel("모바일 이미지").setInputFiles(file("evil.png", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')));
    await expect(dialog.getByText("PNG·JPEG 이미지만 올릴 수 있습니다")).toBeVisible();
    await dialog.getByLabel("모바일 이미지").setInputFiles(file("m.jpg", await canvasJpeg(page, 1080, 1080, "#7b5cff", "MOBILE"), "image/jpeg"));
    await expect(dialog.getByText("1080 × 1080px")).toBeVisible();
    await dialog.getByLabel("링크").fill("javascript:alert(1)");
    await expect(dialog.getByText("쇼핑몰 안 경로(/로 시작) 또는 http(s) 주소만 입력할 수 있습니다")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
    await dialog.getByLabel("링크").fill("/signup");
    await expect(dialog.getByRole("button", { name: "저장" })).toBeEnabled();
    expect(await imageLoaded(page, '[data-testid="banner-preview"] img')).toBe(true);
    await dialog.getByRole("radio", { name: "모바일" }).click();
    expect(await imageLoaded(page, '[data-testid="banner-preview"] img')).toBe(true);
    await dialog.getByRole("radio", { name: "PC" }).click();
    await page.screenshot({ path: `${SHOT}/shop-content-banner-edit-1440.png` });
    await dialog.getByRole("button", { name: "저장" }).click();
    await expect(page.getByText("배너를 추가했습니다")).toBeVisible();

    // 두 번째: PC 이미지만, 한 시간 뒤 시작(예약)
    await page.getByRole("button", { name: "배너 추가" }).first().click();
    const d2 = page.getByRole("dialog", { name: "배너 추가" });
    await d2.getByLabel("배너 이름").fill("추석 연휴 배송 안내");
    await d2.getByLabel("PC 이미지").setInputFiles(file("pc2.png", png(1920, 600, [232, 56, 45])));
    await expect(d2.getByText("1920 × 600px")).toBeVisible();
    await d2.getByLabel("시작 시각").fill(kstLocal(3600_000));
    await d2.getByRole("button", { name: "저장" }).click();
    await expect(page.getByTestId("banner-row")).toHaveCount(2);
    await expect(page.getByTestId("banner-row").nth(1).getByText("게시 예정")).toBeVisible();
    await expect(page.getByTestId("banner-row").nth(0).getByText("게시 중")).toBeVisible();

    // 끌어서 순서 바꾸기 → 새로고침해도 유지
    await page.getByTestId("banner-row").nth(1).dragTo(page.getByTestId("banner-row").nth(0));
    await expect(page.getByText("순서를 저장했습니다")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("banner-row").nth(0)).toContainText("추석 연휴 배송 안내");
    // 키보드·터치용 버튼으로 되돌린다
    await page.getByRole("button", { name: "10월 스타라이트 박스 오픈 위로" }).click();
    await expect(page.getByText("순서를 저장했습니다")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("banner-row").nth(0)).toContainText("10월 스타라이트 박스 오픈");
    await page.screenshot({ path: `${SHOT}/shop-content-banners-1440.png`, fullPage: true });
  });

  test("대표자: 이벤트 팝업 추가(모든 화면·오늘 하루 보지 않기·미리보기)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ownerOpen(page, "/seller/popups");
    await page.getByRole("button", { name: "팝업 추가" }).first().click();
    const dialog = page.getByRole("dialog", { name: "팝업 추가" });
    await dialog.getByLabel("제목").fill("10/4 토 20시 스타라이트 브레이크");
    await dialog.getByLabel("내용").fill("방송 중 주문은 순서대로 열어 드려요.\n주문할 때 방송 닉네임을 꼭 적어 주세요.");
    await dialog.getByLabel("이미지").setInputFiles(file("ev.png", png(800, 500, [255, 196, 81])));
    await expect(dialog.getByText("800 × 500px")).toBeVisible();
    await dialog.getByLabel("링크").fill("/signup");
    await dialog.getByLabel("버튼 이름").fill("회원가입하기");
    await dialog.getByRole("radio", { name: "모든 화면" }).click();
    await expect(dialog.getByTestId("popup-preview")).toContainText("회원가입하기");
    await expect(dialog.getByTestId("popup-preview")).toContainText("오늘 하루 보지 않기");
    // PC·모바일을 모두 끄면 저장할 수 없다
    await dialog.getByLabel("PC", { exact: true }).uncheck();
    await dialog.getByLabel("모바일", { exact: true }).uncheck();
    await expect(dialog.getByText("PC·모바일 중 하나 이상 선택해 주십시오")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
    await dialog.getByLabel("PC", { exact: true }).check();
    await dialog.getByLabel("모바일", { exact: true }).check();
    await page.screenshot({ path: `${SHOT}/shop-content-popup-edit-1440.png` });
    await dialog.getByRole("button", { name: "저장" }).click();
    await expect(page.getByText("팝업을 추가했습니다")).toBeVisible();
    await expect(page.getByTestId("popup-row")).toContainText("모든 화면 · PC · 모바일 · 오늘 하루 보지 않기 허용");
    await page.screenshot({ path: `${SHOT}/shop-content-popups-1440.png`, fullPage: true });
  });

  test("구매자 PC: 홈 배너(게시 중만)와 팝업, 「오늘 하루 보지 않기」는 다시 열어도 안 보임", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/shop/demo-shop");
    const popup = page.getByRole("dialog", { name: "10/4 토 20시 스타라이트 브레이크" });
    await expect(popup).toBeVisible();
    expect(await imageLoaded(page, ".ep-img")).toBe(true);
    await expect(popup.getByRole("link", { name: "회원가입하기" })).toHaveAttribute("href", "/shop/demo-shop/signup");
    // 예약 배너는 아직 안 보이고 게시 중 배너 하나만
    await expect(page.locator(".hb-slide")).toHaveCount(1);
    expect(await imageLoaded(page, ".hb-slide img")).toBe(true);
    await expect(page.locator(".hb-slide a")).toHaveAttribute("href", "/shop/demo-shop/signup");
    await page.screenshot({ path: `${SHOT}/shop-content-shop-home-popup-1440.png` });

    await popup.getByLabel("오늘 하루 보지 않기").check();
    await popup.getByRole("button", { name: "닫기" }).click();
    await expect(popup).toBeHidden();
    await page.screenshot({ path: `${SHOT}/shop-content-shop-home-1440.png` });
    await page.reload();
    await expect(page.locator(".hb-slide")).toHaveCount(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("구매자 모바일: 모바일 이미지로 보이고, 「모든 화면」 팝업은 가입 화면에도 뜬다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/shop/demo-shop");
    const popup = page.getByRole("dialog", { name: "10/4 토 20시 스타라이트 브레이크" });
    await expect(popup).toBeVisible();
    await page.screenshot({ path: `${SHOT}/shop-content-shop-home-popup-390.png` });
    await popup.getByRole("button", { name: "닫기" }).click();
    const src = await page.locator(".hb-slide img").first().evaluate((el) => (el as HTMLImageElement).currentSrc);
    const list = await page.evaluate(async () => (await (await fetch("/api/shop/demo-shop/shop-content?page=home")).json()) as { banners: { mobileImage: { url: string } }[] });
    expect(src).toContain(list.banners[0].mobileImage.url);
    expect(await imageLoaded(page, ".hb-slide img")).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOT}/shop-content-shop-home-390.png` });

    await page.goto("/shop/demo-shop/signup");
    await expect(page.getByRole("dialog", { name: "10/4 토 20시 스타라이트 브레이크" })).toBeVisible();
  });

  test("권한 없는 직원: 메뉴가 없고 주소로 들어가도 권한 안내만", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/seller/login?next=%2Fseller%2Fbanners");
    await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
    await expect(page).toHaveURL(/\/seller\/banners$/);
    await expect(page.getByText("「쇼핑몰 설정」 권한 필요")).toBeVisible();
    await expect(page.getByRole("link", { name: "홈 배너 관리" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "배너 추가" })).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/shop-content-banners-no-permission-1440.png` });
  });
});
