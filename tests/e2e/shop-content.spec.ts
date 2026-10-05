import { expect, request, test, type Page } from "@playwright/test";
import { jpeg, png } from "../unit/shopContentFixtures";
import { submitSellerLogin } from "./sellerLogin";

// SA-064 홈 배너 관리·SA-065 이벤트 팝업 관리(파트너스 관리자, 설정 › 배너 · 팝업)와 구매자 쇼핑몰 홈 표시.
// 실행 시작·끝에 데모 쇼핑몰의 배너·팝업을 모두 지운다.
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
// 지금 KST 기준 datetime-local 값(분 단위)
const kstLocal = (ms: number) => new Date(Date.now() + ms + 9 * 3600_000).toISOString().slice(0, 16);
const POPUP_TITLE = "10/4 토 20시 스타라이트 브레이크";
const BAR_TITLE = "추석 연휴 배송 안내 · 10/2부터 순서대로 보내요";

test.describe.serial("SA-064 홈 배너 · SA-065 이벤트 팝업", () => {
  test("SA-064 대표자: 배너 추가(PNG만·링크 검사·미리보기) → 예약·PC만 배너 → 끌어서 순서 변경", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ownerOpen(page, "/seller/banners");
    await expect(page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "홈 배너", exact: true })).toHaveClass(/on/);
    await expect(page.getByRole("navigation", { name: "배너 · 팝업" }).getByRole("link", { name: "홈 배너", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("등록한 배너가 없습니다")).toBeVisible();

    await page.getByRole("button", { name: "배너 추가" }).first().click();
    const dialog = page.getByRole("dialog", { name: "배너 추가" });
    await expect(dialog.getByText("PNG · 2MB 이하 · 1920 × 600 권장")).toBeVisible();
    await dialog.getByLabel("제목 (대체 텍스트)").fill("10월 스타라이트 박스 오픈");
    // PNG가 아닌 파일(JPEG·SVG)은 내용으로 걸러진다
    await dialog.getByLabel("PC 이미지", { exact: true }).setInputFiles(file("pc.png", jpeg(1200, 400)));
    await expect(dialog.getByText("PNG 파일만 올릴 수 있습니다")).toBeVisible();
    await dialog.getByLabel("PC 이미지", { exact: true }).setInputFiles(file("pc.png", await canvasPng(page, 1920, 600, "#5b3df6", "10월 스타라이트 박스")));
    await expect(dialog.getByText("1920 × 600px · PNG")).toBeVisible();
    // 권장보다 작은 모바일 이미지는 올라가지만 안내가 보인다 → 권장 크기로 바꾼다
    await dialog.getByLabel("모바일 이미지", { exact: true }).setInputFiles(file("m.png", png(300, 300)));
    await expect(dialog.getByText("가로 750px 이상 이미지를 권장합니다 · 지금 파일은 300×300입니다 (올릴 수는 있음)")).toBeVisible();
    await dialog.getByLabel("모바일 이미지", { exact: true }).setInputFiles(file("m.png", await canvasPng(page, 750, 750, "#7b5cff", "MOBILE")));
    await expect(dialog.getByText("750 × 750px · PNG")).toBeVisible();
    await dialog.getByLabel("링크").fill("javascript:alert(1)");
    await expect(dialog.getByText("쇼핑몰 안 경로(/로 시작) 또는 http(s) 주소만 입력할 수 있습니다")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
    await dialog.getByLabel("링크").fill("/signup");
    await expect(dialog.getByRole("button", { name: "저장" })).toBeEnabled();
    expect(await imageLoaded(page, '[data-testid="banner-preview"] img')).toBe(true);
    await page.screenshot({ path: `${SHOT}/SA-064-banner-edit-1440.png` });
    await dialog.getByRole("radio", { name: "모바일" }).last().click();
    expect(await imageLoaded(page, '[data-testid="banner-preview"] img')).toBe(true);
    await dialog.getByRole("button", { name: "저장" }).click();
    await expect(page.getByText("배너를 추가했습니다 · 홈에 바로 반영")).toBeVisible();

    // 두 번째: 한 시간 뒤 시작(예약)
    await page.getByRole("button", { name: "배너 추가" }).first().click();
    const d2 = page.getByRole("dialog", { name: "배너 추가" });
    await d2.getByLabel("제목 (대체 텍스트)").fill("주말 브레이크 안내");
    await d2.getByLabel("PC 이미지", { exact: true }).setInputFiles(file("pc2.png", await canvasPng(page, 1920, 600, "#e8382d", "주말 브레이크")));
    await expect(d2.getByText("1920 × 600px · PNG")).toBeVisible();
    await d2.getByLabel("시작 시각").fill(kstLocal(3600_000));
    await d2.getByRole("button", { name: "저장" }).click();
    // 세 번째: PC만
    await page.getByRole("button", { name: "배너 추가" }).first().click();
    const d3 = page.getByRole("dialog", { name: "배너 추가" });
    await d3.getByLabel("제목 (대체 텍스트)").fill("회원 등급 혜택");
    await d3.getByLabel("PC 이미지", { exact: true }).setInputFiles(file("pc3.png", await canvasPng(page, 1920, 600, "#0f8a5f", "회원 혜택 · PC만")));
    await expect(d3.getByText("1920 × 600px · PNG")).toBeVisible();
    await d3.getByRole("radio", { name: "PC만" }).click();
    await d3.getByRole("button", { name: "저장" }).click();

    await expect(page.getByTestId("banner-row")).toHaveCount(3);
    await expect(page.getByText("배너 3장")).toBeVisible();
    await expect(page.getByTestId("banner-row").nth(1).getByText("예약")).toBeVisible();
    await expect(page.getByTestId("banner-row").nth(2)).toContainText("PC만");

    // 끌어서 순서 바꾸기 → 새로고침해도 유지
    await page.getByTestId("banner-row").nth(2).dragTo(page.getByTestId("banner-row").nth(0));
    await expect(page.getByText("순서를 저장했습니다")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("banner-row").nth(0)).toContainText("회원 등급 혜택");
    // 키보드·터치용 버튼으로 옮긴다
    await page.getByRole("button", { name: "10월 스타라이트 박스 오픈 위로" }).click();
    await expect(page.getByText("순서를 저장했습니다")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("banner-row").nth(0)).toContainText("10월 스타라이트 박스 오픈");
    await page.screenshot({ path: `${SHOT}/SA-064-banners-1440.png`, fullPage: true });

    // 이미지를 올리는 동안은 저장할 수 없다(옛 이미지로 저장되지 않게)
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/seller/shop-content/images", async (route) => {
      await held;
      await route.continue();
    });
    await page.getByTestId("banner-row").nth(0).getByRole("button", { name: "수정" }).click();
    const edit = page.getByRole("dialog", { name: "배너 수정" });
    await expect(edit.getByRole("button", { name: "저장" })).toBeEnabled();
    await edit.getByLabel("PC 이미지", { exact: true }).setInputFiles(file("pc4.png", await canvasPng(page, 1920, 600, "#5b3df6", "10월 스타라이트 박스")));
    await expect(edit.getByRole("button", { name: "이미지 올리는 중" })).toBeDisabled();
    release();
    await expect(edit.getByRole("button", { name: "저장" })).toBeEnabled();
    await page.unroute("**/api/seller/shop-content/images");
    await edit.getByRole("button", { name: "취소" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByTestId("banner-row")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOT}/SA-064-banners-390.png`, fullPage: true });
  });

  test("SA-065 대표자: 이미지 팝업(전체 페이지·7일 보지 않기)과 상단 띠 추가, 복제", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ownerOpen(page, "/seller/banners/popups");
    await expect(page.getByRole("navigation", { name: "배너 · 팝업" }).getByRole("link", { name: "이벤트 팝업", exact: true })).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "팝업 추가" }).first().click();
    const dialog = page.getByRole("dialog", { name: "팝업 추가" });
    // 이미지 팝업은 이미지가 있어야 저장된다
    await dialog.getByLabel("제목 (대체 텍스트)").fill(POPUP_TITLE);
    await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
    await dialog.getByLabel("이미지", { exact: true }).setInputFiles(file("ev.png", await canvasPng(page, 600, 600, "#ffc451", "LIVE 20:00")));
    await expect(dialog.getByText("600 × 600px · PNG")).toBeVisible();
    await dialog.getByLabel("내용").fill("방송 중 주문은 순서대로 열어 드려요.\n주문할 때 방송 닉네임을 꼭 적어 주세요.");
    await dialog.getByLabel("링크").fill("/signup");
    await dialog.getByLabel("버튼 이름").fill("회원가입하기");
    await dialog.getByLabel("노출 페이지").selectOption("ALL");
    await dialog.getByLabel("다시 보지 않기").selectOption("7");
    await expect(dialog.getByTestId("popup-preview")).toContainText("회원가입하기");
    await expect(dialog.getByTestId("popup-preview")).toContainText("7일 동안 보지 않기");
    await dialog.getByRole("radio", { name: "PC만" }).click();
    await dialog.getByRole("radio", { name: "모바일" }).last().click();
    await expect(dialog.getByTestId("popup-preview")).toContainText("모바일에서는 표시하지 않음");
    await dialog.getByRole("radio", { name: "PC · 모바일" }).click();
    await page.screenshot({ path: `${SHOT}/SA-065-popup-edit-1440.png` });
    await dialog.getByRole("button", { name: "저장" }).click();
    await expect(page.getByText("팝업을 추가했습니다")).toBeVisible();

    await page.getByRole("button", { name: "팝업 추가" }).first().click();
    const bar = page.getByRole("dialog", { name: "팝업 추가" });
    await bar.getByRole("radio", { name: "상단 띠" }).click();
    await bar.getByLabel("띠 문구").fill(BAR_TITLE);
    await bar.getByLabel("노출 페이지").selectOption("ALL");
    await expect(bar.getByTestId("popup-preview")).toContainText(BAR_TITLE);
    await bar.getByRole("button", { name: "저장" }).click();
    await expect(page.getByTestId("popup-row")).toHaveCount(2);
    await expect(page.getByTestId("popup-row").nth(0)).toContainText("이미지 팝업 · 가운데 · 전체 페이지 · PC · 모바일");
    await expect(page.getByTestId("popup-row").nth(0)).toContainText("7일 동안 보지 않기");
    await expect(page.getByTestId("popup-row").nth(1)).toContainText("상단 띠 · 맨 위 한 줄");

    // 복제: 같은 값으로 새 팝업(숨김 상태)
    await page.getByTestId("popup-row").nth(1).getByRole("button", { name: "복제" }).click();
    const dup = page.getByRole("dialog", { name: "팝업 추가" });
    await expect(dup.getByLabel("띠 문구")).toHaveValue(`${BAR_TITLE} 복사본`.slice(0, 40));
    await dup.getByRole("button", { name: "저장" }).click();
    await expect(page.getByTestId("popup-row")).toHaveCount(3);
    await expect(page.getByTestId("popup-row").nth(2).getByText("숨김")).toBeVisible();
    await page.screenshot({ path: `${SHOT}/SA-065-popups-1440.png`, fullPage: true });
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
    await expect(page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "홈 배너", exact: true })).toBeVisible();
    await expect(page.getByText("목록만 볼 수 있습니다. 배너 추가 · 수정은 대표자나 쇼핑몰 설정 권한이 있는 직원에게 요청해 주십시오.")).toBeVisible();
    await expect(page.getByTestId("banner-row")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "배너 추가" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "수정" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "삭제" })).toHaveCount(0);
    expect(await imageLoaded(page, ".sc-thumb")).toBe(true);
    // 화면을 거치지 않고 바꾸려 해도 403
    const status = await page.evaluate(async () => (await fetch("/api/seller/shop-content/popups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "TEXT", title: "x", body: "y" }) })).status);
    expect(status).toBe(403);
    await page.screenshot({ path: `${SHOT}/SA-064-staff-readonly-1440.png` });
    await page.getByRole("navigation", { name: "배너 · 팝업" }).getByRole("link", { name: "이벤트 팝업", exact: true }).click();
    await expect(page.getByTestId("popup-row")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "팝업 추가" })).toHaveCount(0);
  });
});
