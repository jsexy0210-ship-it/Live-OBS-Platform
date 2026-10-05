import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { chatEnabledInDb, resetYoutube, seedYoutube } from "./youtubeDb";

// SA-057 유튜브 연결: 채널·방송 연결 상태, 연결한 방송의 채팅 수집 켜기·끄기(보관 고지 표시), 해제.
// 실제 유튜브는 부르지 않는다: 연결은 DB에 직접 만들고, 서버는 YOUTUBE_API_KEY(아무 값)·SCHEDULER_DISABLED=1로 띄운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  if (!process.env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY가 없어요. 서버와 같은 값(아무 값)을 넣고 SCHEDULER_DISABLED=1로 서버를 띄워 주세요");
});
test.afterAll(async () => {
  await resetYoutube();
});

async function login(page: Page, email: string, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}

test("연결 전: 연결 안 됨, 잘못된 채널 주소는 서버 안내를 보인다", async ({ page }) => {
  await resetYoutube();
  await login(page, "demo-owner@example.com", "/seller/products");
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "방송", exact: true }).click();
  await page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "유튜브 연결" }).click();
  await expect(page).toHaveURL(/\/seller\/youtube$/);
  await expect(page.getByTestId("yt-status")).toContainText("연결 안 됨");
  await expect(page.getByTestId("yt-chat-toggle")).toHaveCount(0);
  await page.getByLabel("채널 주소").fill("https://example.com/not-youtube");
  await page.getByRole("button", { name: "연결", exact: true }).first().click();
  await expect(page.getByTestId("yt-channel-error")).toContainText("확인해 주십시오");
});

test("연결된 방송: 채팅 수집은 기본 꺼짐, 켜면 보관 고지가 보이고 서버에 저장되며, 해제하면 사라진다", async ({ page }) => {
  await seedYoutube();
  await login(page, "demo-owner@example.com", "/seller/youtube");
  await expect(page.getByTestId("yt-status")).toContainText("연결됨");
  await expect(page.getByTestId("yt-status")).toContainText("e2e 채널");
  await expect(page.getByTestId("yt-live")).toContainText("e2e 라이브");
  const toggle = page.getByTestId("yt-chat-toggle");
  await expect(toggle).not.toBeChecked();
  // 켜기 전에 보관 고지가 이미 보인다
  await expect(page.getByTestId("yt-chat-notice")).toContainText("30일 동안 보관합니다");
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/SA-057-1440.png", fullPage: true });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => chatEnabledInDb()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("yt-chat-toggle")).toBeChecked();
  await page.getByTestId("yt-chat-toggle").click();
  await expect(page.getByTestId("yt-chat-toggle")).not.toBeChecked();
  await expect.poll(() => chatEnabledInDb()).toBe(false);

  // 방송 연결 해제: 확인 창에서 닫으면 그대로
  await page.getByRole("button", { name: "방송 연결 해제" }).click();
  await page.getByRole("dialog").getByText("닫기", { exact: true }).click();
  await expect(page.getByTestId("yt-live")).toBeVisible();
  await page.getByRole("button", { name: "방송 연결 해제" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "해제" }).click();
  await expect(page.getByTestId("yt-live")).toHaveCount(0);
  expect(await chatEnabledInDb()).toBe(null);

  // 채널 연결 해제
  await page.getByRole("button", { name: "연결 해제", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "해제" }).click();
  await expect(page.getByTestId("yt-status")).toContainText("연결 안 됨");
});

test("서비스 준비 중(서버 키 없음)이면 안내만 보이고 연결 버튼이 꺼져 있다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/products");
  await page.route("**/api/seller/youtube", (route) =>
    route.fulfill({ json: { configured: false, channel: null, live: null, chatNotice: "x" } }),
  );
  await page.goto("/seller/youtube");
  await expect(page.getByTestId("yt-not-ready")).toContainText("유튜브 연결을 준비하고 있습니다");
  await expect(page.getByTestId("yt-status")).toContainText("서비스 준비 중");
  await expect(page.getByLabel("채널 주소")).toBeDisabled();
});

test("방송 진행 권한이 없는 직원: 메뉴가 없고 주소로 들어와도 화면이 없다", async ({ page }) => {
  await login(page, "demo-none@example.com", "/seller/youtube");
  await expect(page.getByText("필요한 권한: 방송 진행")).toBeVisible();
  await expect(page.getByRole("link", { name: "유튜브 연결" })).toHaveCount(0);
});
