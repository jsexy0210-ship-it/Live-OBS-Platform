import { expect, request, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-065 이벤트 팝업 서버 연결: 위치·노출 페이지 5종·방송 연동 옵션이 저장되고, 「모든 팝업 잠시 끄기」가 켜고 꺼진다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const TITLE = "상품 상세 환불 안내";

async function clearPopups() {
  const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
  try {
    expect((await ctx.post("/api/seller/auth/login", { data: { email: "demo-owner@example.com", password: PASSWORD } })).ok()).toBe(true);
    const list = (await (await ctx.get("/api/seller/shop-content/popups")).json()) as { popups: { id: string }[]; popupsPaused: boolean };
    for (const it of list.popups) expect((await ctx.delete(`/api/seller/shop-content/popups/${it.id}`)).ok()).toBe(true);
    if (list.popupsPaused) expect((await ctx.put("/api/seller/shop-content/popups/pause", { data: { paused: false } })).ok()).toBe(true);
  } finally {
    await ctx.dispose();
  }
}

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await clearPopups();
});
test.afterAll(clearPopups);

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/banners/popups")}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/banners\/popups$/);
}
const confirmBtn = (page: Page, name: string) => page.getByRole("dialog").getByRole("button", { name, exact: true });

test("위치·노출 페이지·방송 연동 옵션이 저장되고 다시 열어도 그대로이며, 모든 팝업 잠시 끄기가 켜고 꺼진다", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "팝업 추가" }).first().click();
  const ed = page.getByTestId("popup-editor");
  await ed.getByRole("radio", { name: "글 팝업" }).click();
  await ed.getByLabel("제목", { exact: true }).fill(TITLE);
  await ed.getByLabel("내용").fill("개봉 전 상품만 환불할 수 있어요.");
  await ed.getByLabel("노출 페이지").selectOption("PRODUCT");
  await ed.getByLabel("위치").selectOption("BOTTOM_SHEET");
  await ed.getByLabel("방송 시작 시각에 맞춰 자동 종료").check();
  await ed.getByLabel("방송 중에는 이 팝업을 띄우지 않음", { exact: false }).check();
  await ed.getByRole("button", { name: "저장" }).click();
  await confirmBtn(page, "추가").click();
  await expect(page.getByText("팝업을 추가했습니다")).toBeVisible();

  const row = page.getByTestId("popup-row").filter({ hasText: TITLE });
  await expect(row).toContainText("글 팝업 · 하단 시트 (모바일)");
  await expect(row).toContainText("상품 상세");
  await expect(row).toContainText("—"); // 아직 노출이 없다

  await page.reload();
  await page.getByTestId("popup-row").filter({ hasText: TITLE }).getByRole("button", { name: "수정" }).click();
  await expect(ed.getByLabel("노출 페이지")).toHaveValue("PRODUCT");
  await expect(ed.getByLabel("위치")).toHaveValue("BOTTOM_SHEET");
  await expect(ed.getByLabel("방송 시작 시각에 맞춰 자동 종료")).toBeChecked();
  await expect(ed.getByLabel("방송 중에는 이 팝업을 띄우지 않음", { exact: false })).toBeChecked();
  await ed.getByRole("button", { name: "닫기" }).click();

  // 모든 팝업 잠시 끄기: 확인 창 → 꺼짐 띠(다시 켜기) → 켜기
  await page.getByRole("button", { name: "모든 팝업 잠시 끄기" }).click();
  await expect(page.getByRole("dialog")).toContainText("설정은 그대로 남습니다");
  await confirmBtn(page, "잠시 끄기").click();
  const note = page.getByTestId("popups-paused");
  await expect(note).toContainText("모든 팝업이 꺼져 있습니다");
  await expect(page.getByRole("button", { name: "모든 팝업 잠시 끄기" })).toHaveCount(0);
  await page.screenshot({ path: "tests/e2e/screenshots/SA-065-popups-paused-1440.png", fullPage: true });
  await note.getByRole("button", { name: "다시 켜기" }).click();
  await confirmBtn(page, "다시 켜기").click();
  await expect(note).toHaveCount(0);
  await expect(page.getByRole("button", { name: "모든 팝업 잠시 끄기" })).toBeVisible();

  // 순서: 두 번째 팝업을 만들고 ▲로 올린다
  await page.getByRole("button", { name: "팝업 추가" }).first().click();
  await ed.getByRole("radio", { name: "상단 띠" }).click();
  await ed.getByLabel("띠 문구").fill("배송 지연 안내");
  await ed.getByRole("button", { name: "저장" }).click();
  await confirmBtn(page, "추가").click();
  await expect(page.getByTestId("popup-row")).toHaveCount(2);
  const order = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/popups/reorder"));
  await page.getByRole("button", { name: "배송 지연 안내 위로" }).click();
  expect((await order).status()).toBe(200);
  await expect(page.getByTestId("popup-row").nth(0)).toContainText("배송 지연 안내");
});
