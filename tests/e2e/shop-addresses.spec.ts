import { expect, test, type Page } from "@playwright/test";
import { resetAddressesInDb } from "./cartDb";
import { okConfirm } from "./shopConfirm";

// 보드 SH-027-IA: 배송지 관리(최대 20개 · n / 20, 카드, 기본 배송지로, 새 배송지 추가, 기본 삭제 막힘, 삭제 확인, 20개 한도). 실제 서버·DB.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(() => resetAddressesInDb(SLUG, LOGIN, 0));

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
const cards = (page: Page) => page.locator(".ad-list .ad-card");

test("비회원: 로그인 안내", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/me/addresses`);
  await expect(page.getByRole("heading", { name: "배송지 관리", level: 1 })).toBeVisible();
  await expect(page.getByText("로그인하면 볼 수 있어요")).toBeVisible();
  await expect(page.getByRole("link", { name: "로그인" }).last()).toHaveAttribute("href", /\/login\?next=/);
});

test("PC: 목록(기본 먼저)·기본 배송지로·수정·삭제 확인·기본 삭제 막힘·추가", async ({ page, baseURL }) => {
  await resetAddressesInDb(SLUG, LOGIN, 3);
  await login(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}/me/addresses`);
  await expect(page.getByText("최대 20개 · 3 / 20")).toBeVisible();
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).first()).toContainText("집");
  await expect(cards(page).first()).toContainText("기본");
  await expect(cards(page).first()).toContainText("김별빛 · 01012345678");
  await expect(cards(page).first().getByRole("button", { name: "기본 배송지로" })).toHaveCount(0);
  await page.screenshot({ path: "tests/e2e/screenshots/SH-027-addresses-1440.png", fullPage: true });

  // 기본 배송지는 지울 수 없다(안내만, 서버 호출 없음)
  await cards(page).first().getByRole("button", { name: "삭제" }).click();
  await expect(page.getByText("기본 배송지는 지울 수 없어요 · 다른 배송지를 기본으로 바꾼 뒤 지워 주세요")).toBeVisible();
  await expect(cards(page)).toHaveCount(3);

  // 회사를 기본으로
  await cards(page).filter({ hasText: "회사" }).getByRole("button", { name: "기본 배송지로" }).click();
  await expect(page.getByText("「회사」을 기본 배송지로 바꿨어요")).toBeVisible();
  await expect(cards(page).first()).toContainText("회사"); // 기본이 맨 앞

  // 수정
  await cards(page).filter({ hasText: "부모님 댁" }).getByRole("button", { name: "수정" }).click();
  const edit = page.getByRole("form", { name: "부모님 댁 배송지 수정" });
  await edit.getByLabel("받는 분").fill("김은하수");
  await edit.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText("배송지를 고쳤어요")).toBeVisible();
  await expect(cards(page).filter({ hasText: "부모님 댁" })).toContainText("김은하수");

  // 삭제: 확인 창(취소하면 그대로, 지우기하면 사라짐)
  await cards(page).filter({ hasText: "부모님 댁" }).getByRole("button", { name: "삭제" }).click();
  const dlg = page.getByRole("dialog", { name: "「부모님 댁」 배송지를 지울까요?" });
  await expect(dlg).toContainText("진행 중인 주문의 배송지는 바뀌지 않아요.");
  await dlg.getByRole("button", { name: "취소" }).click();
  await expect(cards(page)).toHaveCount(3);
  await cards(page).filter({ hasText: "부모님 댁" }).getByRole("button", { name: "삭제" }).click();
  await okConfirm(page, "지우기");
  await expect(page.getByText("배송지를 지웠어요")).toBeVisible();
  await expect(cards(page)).toHaveCount(2);

  // 새 배송지 추가(검사 → 저장)
  await page.getByRole("button", { name: "새 배송지 추가" }).click();
  const add = page.getByRole("form", { name: "새 배송지 추가" });
  await add.getByRole("button", { name: "저장" }).click();
  await expect(add.getByRole("alert").first()).toBeVisible(); // 받는 분 등 빈 칸 안내
  await add.getByLabel("배송지 이름").fill("친구 집");
  await add.getByLabel("받는 분").fill("박별");
  await add.getByLabel("연락처").fill("01099998888");
  await add.getByLabel("우편번호").fill("04524");
  await add.getByLabel("주소*", { exact: true }).fill("서울 중구 세종대로 110");
  await add.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText("배송지를 추가했어요")).toBeVisible();
  await expect(cards(page)).toHaveCount(3);
  await expect(page.getByText("최대 20개 · 3 / 20")).toBeVisible();
});

test("20개가 차면 추가 대신 한도 안내", async ({ page, baseURL }) => {
  await resetAddressesInDb(SLUG, LOGIN, 20);
  await login(page, baseURL!);
  await page.goto(`/shop/${SLUG}/me/addresses`);
  await expect(page.getByText("최대 20개 · 20 / 20")).toBeVisible();
  await expect(page.getByText("배송지는 20개까지 저장할 수 있어요 · 안 쓰는 배송지를 지운 뒤 추가해 주세요")).toBeVisible();
  await expect(page.getByRole("button", { name: "새 배송지 추가" })).toHaveCount(0);
});

for (const vp of [
  { name: "1024", w: 1024, h: 800 },
  { name: "390", w: 390, h: 844 },
]) {
  test(`${vp.name}: 배송지 관리 화면`, async ({ page, baseURL }) => {
    await resetAddressesInDb(SLUG, LOGIN, 3);
    await login(page, baseURL!);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto(`/shop/${SLUG}/me/addresses`);
    await expect(cards(page)).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `tests/e2e/screenshots/SH-027-addresses-${vp.name}.png` });
    await page.getByRole("button", { name: "새 배송지 추가" }).click();
    await expect(page.getByRole("form", { name: "새 배송지 추가" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
