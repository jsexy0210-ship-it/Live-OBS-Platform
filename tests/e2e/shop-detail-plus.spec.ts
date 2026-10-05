import { expect, test } from "@playwright/test";

// IA ④ 상품 상세 보강: 품절 상품의 재입고 알림 신청·취소, 추천 상품 영역(자기 자신 제외). 데모 시드(품절 「드래곤 소울 부스터」·구매자 demo-buyer1).
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

type Card = { id: string; name: string; soldOut: boolean };

test("품절 상품: 재입고 알림 받기 → 새로고침 뒤에도 신청 상태 → 취소", async ({ page, baseURL }) => {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL! } });
  expect(r.status()).toBe(200);
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: Card[] };
  const sold = list.products.find((p) => p.name === "드래곤 소울 부스터")!;
  expect(sold.soldOut).toBe(true);
  await page.request.delete(`/api/shop/${SLUG}/restock-alerts/${sold.id}`, { headers: { origin: baseURL! } }); // 이전 실행 흔적

  await page.goto(`/shop/${SLUG}/products/${sold.id}`);
  await expect(page.getByRole("button", { name: "품절됐어요" })).toBeDisabled();
  await page.getByRole("button", { name: "재입고 알림 받기" }).click();
  await expect(page.getByText("다시 입고되면 알려 드릴게요")).toBeVisible();
  await page.reload();
  const cancel = page.getByRole("button", { name: "재입고 알림 취소" });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(page.getByText("재입고 알림을 취소했어요")).toBeVisible();
  await expect(page.getByRole("button", { name: "재입고 알림 받기" })).toBeVisible();
});

test("비회원이 재입고 알림을 누르면 로그인 안내가 뜬다", async ({ page }) => {
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: Card[] };
  const sold = list.products.find((p) => p.name === "드래곤 소울 부스터")!;
  await page.goto(`/shop/${SLUG}/products/${sold.id}`);
  await page.getByRole("button", { name: "재입고 알림 받기" }).click();
  await expect(page.getByRole("dialog", { name: "로그인이 필요해요" })).toBeVisible();
});

test("판매 중 상품: 재입고 버튼은 없고 추천 상품 영역에 자기 자신이 없다", async ({ page }) => {
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: Card[] };
  const p = list.products.find((x) => x.name === "탑로더 25장")!;
  await page.goto(`/shop/${SLUG}/products/${p.id}`);
  await expect(page.getByRole("button", { name: "재입고 알림 받기" })).toHaveCount(0);
  const reco = page.getByRole("region", { name: "함께 보면 좋아요" });
  await expect(reco).toBeVisible();
  const n = await reco.locator("li.pc").count();
  expect(n).toBeGreaterThan(0);
  await expect(reco.getByRole("link", { name: "탑로더 25장", exact: true })).toHaveCount(0);
  await reco.locator("a.pc-name").first().click();
  await expect(page).toHaveURL(/\/products\/[^/?]+$/);
});
