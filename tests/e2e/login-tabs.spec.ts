import { expect, test, type Page } from "@playwright/test";

// AU-002 파트너스 관리자 로그인: 카드 안 로고, 대표자·직원 탭(키보드), 탭별 링크, accountType 전송, wrong_account_type 안내,
// AU-011 아이디 찾기(본인확인 대행사 연결 전 준비 중 상태). 실제 찾기 흐름은 개발 서버에서 partners-auth-flow.spec.ts가 확인한다. 정본: docs/IA.md AU-002·AU-011.
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

test("로고는 카드 안 맨 위, 기본은 대표자 탭이고 한 줄에 왼쪽 「아직 파트너스가 아니십니까? 가입 신청」·오른쪽 끝 「아이디/비밀번호 찾기」가 있다. 직원 탭은 찾기만 오른쪽 끝에 있다", async ({ page }) => {
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

  const nav = page.getByRole("navigation", { name: "계정 도움" });
  const find = page.getByRole("link", { name: "이메일(아이디)/비밀번호 찾기" });
  const join = page.getByRole("link", { name: "가입 신청" });
  await expect(page.getByRole("tab", { name: "대표자" })).toHaveAttribute("aria-selected", "true");
  // 「가입 신청」만 링크(앞 문구는 글자), 찾기는 오른쪽 끝
  await expect(links(page)).toHaveText(["가입 신청", "이메일(아이디)/비밀번호 찾기"]);
  await expect(nav).toContainText("아직 파트너스가 아니십니까? 가입 신청");
  await expect(join).toHaveAttribute("href", "/seller/signup");
  await expect(find).toHaveAttribute("href", "/seller/find-id");
  // 회원가입만 강조색(찾기와 앞 문구는 같은 보조색)
  const colors = await nav.evaluate((el) => {
    const c = (sel: string) => getComputedStyle(el.querySelector(sel)!).color;
    return { join: c(".login-join > a"), text: c(".login-join"), find: c(".login-find") };
  });
  expect(colors.join).not.toBe(colors.find);
  expect(colors.text).toBe(colors.find);
  // 시안: 밑줄 없음(마우스를 올렸을 때만)
  for (const link of [join, find]) expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
  await find.hover();
  expect(await find.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("underline");
  // 마우스를 올려도 강조색으로 바뀌지 않고 회색 그대로
  expect(await find.evaluate((el) => getComputedStyle(el).color)).toBe(colors.find);
  await page.mouse.move(0, 0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const box = (await nav.boundingBox())!;
    const l = (await page.locator(".login-join").boundingBox())!;
    const r = (await find.boundingBox())!;
    expect(Math.abs(l.x - box.x)).toBeLessThan(2);
    expect(Math.abs(r.x + r.width - (box.x + box.width))).toBeLessThan(2);
    // 한 줄(같은 높이)
    expect(Math.abs(l.y - r.y)).toBeLessThan(2);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot(page, "AU-002-owner");

  await page.getByRole("tab", { name: "직원" }).click();
  await expect(page.getByRole("tab", { name: "직원" })).toHaveAttribute("aria-selected", "true");
  await expect(links(page)).toHaveText(["이메일(아이디)/비밀번호 찾기"]);
  await expect(nav).not.toContainText("회원");
  await expect(find).toHaveAttribute("href", "/seller/find-id?type=staff");
  const box = (await nav.boundingBox())!;
  const r = (await find.boundingBox())!;
  expect(Math.abs(r.x + r.width - (box.x + box.width))).toBeLessThan(2);
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
  await expect(page).toHaveURL(/\/seller$/);
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
  await expect(page.getByText("직원 계정입니다. 직원 탭에서 로그인해 주십시오")).toBeVisible();
  await shot(page, "AU-002-wrong-type");
  await page.getByRole("button", { name: "직원으로 로그인하기" }).click();
  await expect(page.getByRole("tab", { name: "직원" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "직원" })).toBeFocused();
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByText("대표자 계정입니다. 대표자 탭에서 로그인해 주십시오")).toBeVisible();
  expect(bodies.map((b) => b.accountType)).toEqual(["owner", "staff"]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("대표자 탭에서 쇼핑몰 주소를 물은 뒤 직원 탭으로 바꾸면 쇼핑몰 칸이 사라지고 바로 로그인된다", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  let first = true;
  await page.route("**/api/seller/auth/login", (route) => {
    bodies.push(route.request().postDataJSON());
    if (!first) return route.continue();
    first = false;
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "shop_required", message: "로그인할 쇼핑몰을 골라 주십시오" }) });
  });
  await page.goto("/seller/login");
  await page.getByLabel("이메일").fill("demo-staff@example.com");
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByLabel("쇼핑몰 주소")).toBeVisible();
  await page.getByLabel("쇼핑몰 주소").fill("demo-shop");
  await page.getByRole("tab", { name: "직원" }).click();
  await expect(page.getByLabel("쇼핑몰 주소")).toHaveCount(0);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller$/);
  // 직원 탭 요청에는 앞 탭에서 적은 쇼핑몰 주소가 실리지 않는다
  expect(bodies[1]).toMatchObject({ accountType: "staff" });
  expect(bodies[1]).not.toHaveProperty("shopSlug");
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("로그인 전 직원 본인확인 연결 화면에 오면 직원 탭 로그인으로 한 번만 보내고, 로그인하면 원래 가려던 곳으로 간다", async ({ page }) => {
  const logins: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame() && new URL(f.url()).pathname === "/seller/login") logins.push(f.url());
  });
  await page.goto("/seller/identity-link?next=%2Fseller%2Forders");
  await expect(page).toHaveURL(/\/seller\/login\?type=staff&next=%2Fseller%2Forders$/);
  await expect(page.getByRole("tab", { name: "직원" })).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(500);
  expect(logins).toHaveLength(1);
  await page.getByLabel("이메일").fill("demo-viewer@example.com");
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/orders$/);
});

test("본인확인을 쓸 수 없는 서버(대행사 미연결)에서는 연결하지 않은 직원도 연결 안내 없이 바로 들어간다", async ({ page }) => {
  await page.goto("/seller/login?type=staff");
  const status = page.waitForResponse((r) => r.url().endsWith("/api/seller/me/identity"));
  await page.getByLabel("이메일").fill("demo-staff@example.com");
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  expect(await (await status).json()).toMatchObject({ available: false, linked: false });
  await expect(page).toHaveURL(/\/seller$/);
});

test("아이디 찾기: 본인확인 대행사 연결 전이면 인증번호 받기에서 준비 중 화면으로 바뀐다", async ({ page }) => {
  await page.goto("/seller/login");
  await page.getByRole("link", { name: "이메일(아이디)/비밀번호 찾기" }).click();
  await expect(page).toHaveURL(/\/seller\/find-id$/);
  await expect(page.getByRole("heading", { name: "이메일(아이디) 찾기" })).toBeVisible();
  await page.getByLabel("이름", { exact: true }).fill("김별빛");
  await page.getByLabel("생년월일").fill("19900101");
  await page.getByRole("button", { name: "남", exact: true }).click();
  await page.getByLabel("통신사").selectOption("SKT");
  await page.getByLabel("휴대폰번호", { exact: true }).fill("01012345678");
  await page.getByLabel("본인확인 이용 약관에 모두 동의합니다").check();
  const res = page.waitForResponse((r) => r.url().endsWith("/api/seller/find-id/start"));
  await page.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "문자 받기" }).click();
  expect((await res).status()).toBe(503);
  await expect(page.getByRole("heading", { name: "본인 확인 서비스를 준비하는 중입니다" })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(/판매자|cafe24|카페24/i);
  await shot(page, "AU-011-unavailable");
});

test("직원 탭 흐름 전체에서 계정 종류가 이어진다: 로그인 → 아이디 찾기 → 비밀번호 찾기 → 로그인 복귀(직원 탭)", async ({ page }) => {
  await page.goto("/seller/login");
  await page.getByRole("tab", { name: "직원" }).click();
  await page.getByRole("link", { name: "이메일(아이디)/비밀번호 찾기" }).click();
  await expect(page).toHaveURL(/\/seller\/find-id\?type=staff$/);
  // 화면 위쪽 「아이디 찾기 | 비밀번호 찾기」 전환
  const sw = page.getByRole("navigation", { name: "아이디·비밀번호 찾기" });
  await expect(sw.getByRole("link")).toHaveText(["아이디 찾기", "비밀번호 찾기"]);
  await expect(sw.getByRole("link", { name: "아이디 찾기" })).toHaveAttribute("aria-current", "page");
  await expect(sw.getByRole("link", { name: "비밀번호 찾기" })).toHaveAttribute("href", "/seller/password-reset?type=staff");
  await expect(page.getByRole("link", { name: "로그인으로 돌아가기" })).toHaveAttribute("href", "/seller/login?type=staff");
  await shot(page, "AU-011-switch");
  await sw.getByRole("link", { name: "비밀번호 찾기" }).click();
  await expect(page).toHaveURL(/\/seller\/password-reset\?type=staff$/);
  await expect(sw.getByRole("link", { name: "비밀번호 찾기" })).toHaveAttribute("aria-current", "page");
  await expect(sw.getByRole("link", { name: "아이디 찾기" })).toHaveAttribute("href", "/seller/find-id?type=staff");
  await shot(page, "AU-003-switch");
  await expect(page.getByText("직원 본인 명의의 휴대폰으로 확인합니다.")).toBeVisible();
  await page.getByRole("link", { name: "로그인으로 돌아가기" }).click();
  await expect(page).toHaveURL(/\/seller\/login\?type=staff$/);
  await expect(page.getByRole("tab", { name: "직원" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("link", { name: "가입 신청" })).toHaveCount(0);
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
