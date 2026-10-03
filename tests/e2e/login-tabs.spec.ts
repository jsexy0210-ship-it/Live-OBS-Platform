import { expect, test, type Page } from "@playwright/test";

// AU-002 파트너스 관리자 로그인: 카드 안 로고, 대표자·직원 탭(키보드), 탭별 링크, accountType 전송, wrong_account_type 안내,
// AU-011 아이디 찾기(서버 API 전 준비 중 상태). 정본: docs/IA.md AU-002·AU-011.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

const links = (page: Page) => page.getByRole("navigation", { name: "계정 도움" }).getByRole("link");

test("로고는 카드 안 맨 위, 기본은 대표자 탭이고 회원가입·아이디 찾기·비밀번호 찾기 링크가 있다. 직원 탭은 회원가입이 없다", async ({ page }) => {
  await page.goto("/seller/login");
  const card = page.locator(".login-card");
  await expect(card.locator(".logo")).toBeVisible();
  await expect(page.locator(".login-page > .logo")).toHaveCount(0);
  // 순서: 로고 → 제목 → 탭 → 입력
  const order = await card.evaluate((el) => {
    const pos = (sel: string) => el.querySelector(sel)!.getBoundingClientRect().top;
    return [pos(".logo"), pos("h1"), pos("[role=tablist]"), pos("#email")];
  });
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  await expect(page.getByRole("tab", { name: "대표자" })).toHaveAttribute("aria-selected", "true");
  await expect(links(page)).toHaveText(["회원가입", "아이디 찾기", "비밀번호 찾기"]);
  await expect(page.getByRole("link", { name: "아이디 찾기" })).toHaveAttribute("href", "/seller/find-id");
  await shot(page, "AU-002-owner");

  await page.getByRole("tab", { name: "직원" }).click();
  await expect(page.getByRole("tab", { name: "직원" })).toHaveAttribute("aria-selected", "true");
  await expect(links(page)).toHaveText(["아이디 찾기", "비밀번호 찾기"]);
  await expect(page.getByRole("link", { name: "비밀번호 찾기" })).toHaveAttribute("href", "/seller/password-reset?type=staff");
  await expect(page.getByRole("link", { name: "아이디 찾기" })).toHaveAttribute("href", "/seller/find-id?type=staff");
  await shot(page, "AU-002-staff");
});

test("탭은 키보드 화살표로 옮겨 고를 수 있다", async ({ page }) => {
  await page.goto("/seller/login");
  const owner = page.getByRole("tab", { name: "대표자" });
  const staff = page.getByRole("tab", { name: "직원" });
  await owner.focus();
  await page.keyboard.press("ArrowRight");
  await expect(staff).toBeFocused();
  await expect(staff).toHaveAttribute("aria-selected", "true");
  await expect(owner).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("ArrowLeft");
  await expect(owner).toBeFocused();
  await expect(owner).toHaveAttribute("aria-selected", "true");
});

test("로그인 요청에 고른 탭을 보내고, 아직 그 값을 모르는 서버에서도 대표자 로그인은 그대로 된다", async ({ page }) => {
  await page.goto("/seller/login");
  await page.getByLabel("이메일").fill("demo-owner@example.com");
  await page.getByLabel("비밀번호").fill(PASSWORD);
  const req = page.waitForRequest((r) => r.url().endsWith("/api/seller/auth/login"));
  await page.getByRole("button", { name: "로그인" }).click();
  expect(((await req).postDataJSON() as { accountType: string }).accountType).toBe("owner");
  await expect(page).toHaveURL(/\/seller\/products$/);
});

test("고른 탭과 계정 종류가 다르면(wrong_account_type) 맞는 탭으로 안내하고, 버튼으로 탭을 바꾼다", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/seller/auth/login", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "wrong_account_type" }) });
  });
  await page.goto("/seller/login");
  await page.getByLabel("이메일").fill("someone@example.com");
  await page.getByLabel("비밀번호").fill("password-1");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByText("직원 계정이에요. 직원 탭에서 로그인하세요")).toBeVisible();
  await shot(page, "AU-002-wrong-type");
  await page.getByRole("button", { name: "직원 탭으로" }).click();
  await expect(page.getByRole("tab", { name: "직원" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "직원" })).toBeFocused();
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByText("대표자 계정이에요. 대표자 탭에서 로그인하세요")).toBeVisible();
  expect(bodies.map((b) => b.accountType)).toEqual(["owner", "staff"]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("아이디 찾기: 서버 기능 준비 전에는 준비 중 화면을 보여 준다", async ({ page }) => {
  await page.goto("/seller/login");
  await page.getByRole("link", { name: "아이디 찾기" }).click();
  await expect(page).toHaveURL(/\/seller\/find-id$/);
  await expect(page.getByRole("heading", { name: "아이디를 찾아요" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "본인확인 서비스 준비 중이에요" })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(/판매자|cafe24|카페24/i);
  await shot(page, "AU-011");
});

// 대표님 결정(2026-10-04): 외부 쇼핑몰 플랫폼 이름은 어떤 화면에도 보이지 않는다. 화면 코드(app·components, 서버 API 제외)에서 0건이어야 한다.
test("화면 코드에 외부 쇼핑몰 플랫폼 이름(cafe24·카페24)이 없다", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (p === join("app", "api")) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(name) && /cafe\s*24|카페\s*24/i.test(readFileSync(p, "utf8"))) hits.push(p);
    }
  };
  for (const d of ["app", "components", "styles"]) walk(d);
  expect(hits).toEqual([]);
});
