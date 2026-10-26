import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 대신 보기(me.readOnly)에서는 방송·오버레이 화면의 바꾸는 버튼이 막히고 이유(title)가 붙는다. 일반 세션은 그대로다.
// 실제 로그인 뒤 /api/seller/me 응답에만 readOnly를 얹어 확인한다(쓰기 요청이 나가지 않는지도 본다).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const REASON = "대신 보기에서는 볼 수만 있습니다";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function login(page: Page, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}
async function viewOnly(page: Page) {
  await page.route("**/api/seller/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), readOnly: true } });
  });
}

test("대신 보기: 방송 화면 편집기는 저장·템플릿 버튼이 막히고 이유가 붙는다", async ({ page }) => {
  await login(page, "/seller/overlay");
  const writes: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/seller/") && r.method() !== "GET") writes.push(`${r.method()} ${r.url()}`); });
  await viewOnly(page);
  await page.reload();
  await expect(page.getByTestId("ove")).toBeVisible();
  const save = page.getByRole("button", { name: "방송 화면에 저장하기", exact: true });
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("title", REASON);
  expect(writes).toEqual([]);
});

test("대신 보기: 방송 프로그램에 넣기의 주소 만들기·재발급이 막히고 이유가 붙는다", async ({ page }) => {
  await login(page, "/seller/overlay/address");
  await viewOnly(page);
  await page.reload();
  const issue = page.getByRole("button", { name: /^(재발급|주소 만들기)$/ }).first();
  await expect(issue).toBeDisabled();
  await expect(issue).toHaveAttribute("title", REASON);
});

test("대신 보기: 유튜브의 연결·지우기 버튼이 막힌다", async ({ page }) => {
  await login(page, "/seller/youtube");
  await viewOnly(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "연결", level: 2 }).or(page.getByTestId("yt-not-ready"))).toBeVisible();
  for (const btn of await page.getByRole("button", { name: /유튜브 이어 둔 것 풀기|다른 채널로 바꾸기|방송 이어 둔 것 풀기|지금 하는 방송 찾아서|저장해 둔 채팅 지금 지우기/ }).all()) await expect(btn).toBeDisabled();
});
