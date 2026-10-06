import { expect, test, type Page } from "@playwright/test";
import { clearInquiriesInDb, INQUIRY_TITLES, seedInquiriesInDb } from "./buyerInquiryDb";
import { okConfirm } from "./shopConfirm";

// 보드 SH-026-IA: 내 문의(탭 개수 · 표 · 답변 보기 · 문의하기 · 빈 상태 · 등록 완료 · 입력 오류). 실제 서버·DB.
const SLUG = "demo-shop";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(() => clearInquiriesInDb(SLUG));

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
const rows = (page: Page) => page.locator(".mi-tbl tbody tr");

test("비회원: 로그인 안내", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/me/inquiries`);
  await expect(page.getByRole("heading", { name: "내 문의", level: 1 })).toBeVisible();
  await expect(page.getByText("로그인하면 볼 수 있어요")).toBeVisible();
});

test("PC: 탭 개수·표·답변 보기·비공개 표시, 문의하기(검사 → 등록 → 목록에 보임)", async ({ page, baseURL }) => {
  await seedInquiriesInDb(SLUG);
  await login(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}/me/inquiries`);
  const tabs = page.getByRole("tablist", { name: "문의 종류" });
  await expect(tabs.getByRole("tab", { name: /^전체 3$/ })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /^상품 문의 1$/ })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /^1:1 문의 2$/ })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).filter({ hasText: INQUIRY_TITLES.private })).toContainText("🔒");
  await expect(rows(page).filter({ hasText: INQUIRY_TITLES.waiting })).toContainText("답변 대기");
  const answered = rows(page).filter({ hasText: INQUIRY_TITLES.answered });
  await expect(answered).toContainText("답변 완료");
  await expect(rows(page).filter({ hasText: INQUIRY_TITLES.waiting }).getByRole("button", { name: "답변 보기" })).toHaveCount(0);
  await answered.getByRole("button", { name: "답변 보기" }).click();
  await expect(answered).toContainText("내일 도착 예정입니다");
  await expect(answered).toContainText("판매자");
  await page.screenshot({ path: "tests/e2e/screenshots/SH-026-inquiries-1440.png", fullPage: true });
  await tabs.getByRole("tab", { name: /^상품 문의/ }).click();
  await expect(rows(page)).toHaveCount(1);
  await tabs.getByRole("tab", { name: /^전체/ }).click();

  // 문의하기: 빈 칸 검사 → 1:1 문의 등록
  await page.getByRole("button", { name: "문의하기" }).click();
  const form = page.getByRole("dialog", { name: "문의하기" });
  await form.getByRole("button", { name: "문의 등록" }).click();
  await expect(form.getByText("문의할 상품을 골라 주세요")).toBeVisible();
  await expect(form.getByText("제목을 적어 주세요")).toBeVisible();
  await expect(form.getByText("내용을 적어 주세요")).toBeVisible();
  await form.getByLabel("1:1 문의 (주문 · 배송 · 기타)").check();
  await form.getByLabel(/^제목/).fill("문의e2e-새 문의");
  await form.getByLabel(/^내용/).fill("배송지를 바꾸고 싶어요");
  await form.getByLabel("비공개 (작성자와 판매자만 봐요)").check();
  await form.getByRole("button", { name: "문의 등록" }).click();
  await okConfirm(page, "등록하기");
  await expect(page.getByText("문의를 등록했어요 · 답변은 알림톡으로 알려 드려요")).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).first()).toContainText("문의e2e-새 문의"); // 최신이 맨 위
  await expect(tabs.getByRole("tab", { name: /^1:1 문의 3$/ })).toBeVisible();
});

test("빈 상태", async ({ page, baseURL }) => {
  await clearInquiriesInDb(SLUG);
  await login(page, baseURL!);
  await page.goto(`/shop/${SLUG}/me/inquiries`);
  await expect(page.getByRole("heading", { name: "아직 문의가 없어요" })).toBeVisible();
  await expect(page.getByText("상품 상세나 주문 상세에서 바로 물어볼 수 있어요")).toBeVisible();
});

for (const vp of [
  { name: "1024", w: 1024, h: 800 },
  { name: "390", w: 390, h: 844 },
]) {
  test(`${vp.name}: 내 문의 화면`, async ({ page, baseURL }) => {
    await seedInquiriesInDb(SLUG);
    await login(page, baseURL!);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto(`/shop/${SLUG}/me/inquiries`);
    await expect(rows(page)).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `tests/e2e/screenshots/SH-026-inquiries-${vp.name}.png` });
    await page.getByRole("button", { name: "문의하기" }).click();
    await expect(page.getByRole("dialog", { name: "문의하기" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `tests/e2e/screenshots/SH-026-inquiry-form-${vp.name}.png` });
  });
}
