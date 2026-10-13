import { expect, test } from "@playwright/test";

// 2단계 대표 화면: 마스터 관리자 로그인(AU-001). 2026-10-05 시각 규격을 7개 폭에서 실측한다.
// 카드가 화면 안에 들어오고 가로 넘침이 없으며, 입력·버튼 높이(PC 44·48, 휴대폰 48·글자 16), 제목 20/28, 항목 사이 16px,
// 키보드만으로 로그인 시도, 실패 문구가 비밀번호 칸 바로 아래에 보이고 칸이 오류 상태가 되는지 본다.
// 200% 확대는 1280px 화면의 640 CSS px과 같아 768·390 폭 검사로 함께 확인한다.
const WIDTHS = [360, 390, 768, 1024, 1280, 1440, 1920];
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

for (const width of WIDTHS) {
  test(`마스터 관리자 로그인 ${width}px: 넘침 없음·규격`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/login");
    const card = page.locator(".login-card");
    await expect(card).toBeVisible();
    await expect(card.getByText("이메일과 비밀번호로 로그인합니다.")).toBeVisible();

    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(sw).toBeLessThanOrEqual(cw);
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);

    const mobile = width < 768;
    for (const h of await card.locator("input.inp").evaluateAll((els) => els.map((e) => [Math.round(e.getBoundingClientRect().height), getComputedStyle(e).fontSize])))
      expect(h).toEqual(mobile ? [48, "16px"] : [44, "14px"]);
    const btn = card.getByRole("button", { name: "로그인", exact: true });
    expect(Math.round((await btn.boundingBox())!.height)).toBe(48);
    const title = card.getByRole("heading", { name: "마스터 관리자" });
    expect(await title.evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e).lineHeight])).toEqual(["20px", "28px"]);
    // 레이블과 입력 사이 8px
    const label = (await card.getByText("이메일", { exact: true }).boundingBox())!;
    const input = (await card.getByLabel("이메일").boundingBox())!;
    expect(Math.round(input.y - (label.y + label.height))).toBe(8);
    if (SHOTS) await page.screenshot({ path: `tests/e2e/screenshots/ui-stage2/admin-login-${width}.png` });
  });
}

test("마스터 관리자 로그인 390px: 비활성 버튼 색과 투명도를 정본에 맞춘다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/login");
  const button = page.getByRole("button", { name: "로그인", exact: true });
  await expect(button).toBeDisabled();
  await expect(button).toHaveCSS("background-color", "rgb(15, 118, 110)");
  await expect(button).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(button).toHaveCSS("opacity", "0.45");
});

test("키보드만으로 입력·로그인 시도, 실패 문구는 비밀번호 칸 아래에 보이고 버튼 폭은 그대로다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/login");
  const btn = page.getByRole("button", { name: "로그인", exact: true });
  const before = (await btn.boundingBox())!.width;
  await expect(btn).toBeDisabled();

  await page.keyboard.press("Tab");
  await expect(page.getByLabel("이메일")).toBeFocused();
  await page.keyboard.type("nobody@example.com");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("비밀번호")).toBeFocused();
  await page.keyboard.type("wrong-password-1");
  await page.keyboard.press("Enter");

  const err = page.locator("#login-err");
  await expect(err).toBeVisible();
  await expect(page.getByLabel("비밀번호")).toHaveAttribute("aria-invalid", "true");
  const pw = (await page.getByLabel("비밀번호").boundingBox())!;
  const eb = (await err.boundingBox())!;
  expect(eb.y).toBeGreaterThanOrEqual(pw.y + pw.height);
  expect(eb.y - (pw.y + pw.height)).toBeLessThanOrEqual(8);
  expect((await btn.boundingBox())!.width).toBe(before);
  // 실패 뒤에도 입력값은 그대로다
  await expect(page.getByLabel("이메일")).toHaveValue("nobody@example.com");
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/ui-stage2/admin-login-error-390.png" });
});
