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
  // 보기만 가능한 동안에도 가로·세로 비율을 바꿔 저장된 배치를 볼 수 있다(비율 전환은 저장이 아니다)
  const radios = page.getByRole("radio");
  await expect(radios.first()).toBeEnabled();
  await radios.nth(1).click();
  await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
  expect(writes).toEqual([]);
});

test("대신 보기: 가로·세로 배치는 조회할 수 있고 편집과 쓰기는 막힌다", async ({ page }) => {
  await login(page, "/seller/overlay");
  const writes: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/seller/") && r.method() !== "GET") writes.push(`${r.method()} ${r.url()}`); });
  await viewOnly(page);
  await page.reload();
  const canvas = page.getByTestId("ove-canvas");
  await expect(canvas).toBeVisible();

  for (const [name, aspect, width, height] of [["가로 16:9", "16x9", "1920px", "1080px"], ["세로 9:16", "9x16", "1080px", "1920px"]]) {
    const loaded = page.waitForResponse((r) => r.url().endsWith(`/api/seller/overlay/layout?aspect=${aspect}`) && r.request().method() === "GET");
    const option = page.getByRole("radio", { name, exact: true });
    await option.click();
    expect((await loaded).ok()).toBe(true);
    await expect(option).toHaveAttribute("aria-checked", "true");
    await expect(canvas.locator(".ove-stage")).toHaveCSS("width", width);
    await expect(canvas.locator(".ove-stage")).toHaveCSS("height", height);
    await expect(canvas).toBeVisible();
    await expect(page.locator('.ove-slots input[type="checkbox"]').first()).toBeDisabled();
    await expect(page.locator(".ove-z").first()).toBeDisabled();
    await page.locator(".ove-name:enabled").first().click();
    await expect(page.getByTestId("ove-props").getByLabel("가로 위치")).toBeVisible();
    await expect(page.getByTestId("ove-props").getByLabel("가로 위치")).toBeDisabled();
    await expect(page.getByRole("button", { name: "방송 화면에 저장하기", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "스포트라이트형", exact: true })).toBeDisabled();
  }

  // 칸들이 겹쳐 있을 수 있어, 방금 고른(맨 위에 보이는) 칸으로 끌어 본다
  const box = page.locator('[data-testid^="ove-box-"].is-sel');
  await expect(box).toBeVisible();
  const before = await box.getAttribute("style");
  const bounds = (await box.boundingBox())!;
  await box.hover();
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await expect(box).toHaveAttribute("style", before!);
  await expect(page.getByTestId("ove-dirty")).toHaveCount(0);
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
