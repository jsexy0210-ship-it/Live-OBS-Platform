import { expect, test, type Page } from "@playwright/test";

// 파트너스 가입 신청(PF-007) → 로그인 → 비밀번호 찾기(AU-003·004)를 실제 API로 끝까지 확인한다.
// 개발 서버(playwright.config.ts 「dev」)에서 돈다: 가짜 본인확인 공급자(인증번호 000000)와
// 가짜 사업자·통신판매업 조회(BUSINESS_STATUS_PROVIDER=fake, MAIL_ORDER_PROVIDER=fake → 처음 보는 번호는 정상으로 본다)가 필요하다.
// 실행마다 가입용 본인확인 2회를 쓴다(같은 IP 하루 10회 한도, DB를 새로 만들면 풀린다).
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

// 실행마다 다른 대표자(가짜 공급자는 이름·생년월일로 사람을 가른다 · 한 대표자는 쇼핑몰 하나)·사업자번호·주소·이메일
const uniq = () => `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 36 ** 2).toString(36)}`;
const letters = (s: string) => Array.from(s, (c) => "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허"[parseInt(c, 36) % 28]).join("");

// 검증 숫자가 맞는 사업자등록번호(국세청 규칙)
function businessNumber(): string {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  n[0] = n[0] || 1;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  const sum = w.reduce((acc, wi, i) => acc + n[i] * wi, 0) + Math.floor((n[8] * 5) / 10);
  return [...n, (10 - (sum % 10)) % 10].join("");
}

async function fillIdentity(page: Page, name: string) {
  await page.getByLabel("이름", { exact: true }).fill(name);
  await page.getByLabel("생년월일").fill("19900101");
  await page.getByRole("button", { name: "남", exact: true }).click();
  await page.getByLabel("통신사").selectOption("SKT");
  await page.getByLabel("휴대폰번호", { exact: true }).fill("01012345678");
  await page.getByLabel("본인확인 약관에 모두 동의해요").check();
}

// 인증번호 받기 → (틀린 번호 한 번) → 000000 확인
async function verify(page: Page, wrongFirst = false, startPath = "/api/seller-signup/verification") {
  const started = page.waitForRequest((r) => r.url().endsWith(startPath) && r.method() === "POST");
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  // 본인확인 대행사에 보내는 기기 구분: 768px 이상이면 PC(구매자 가입과 같은 기준)
  const body = (await started).postDataJSON() as { device?: string; person?: { device?: string } };
  expect(body.device ?? body.person?.device).toBe((page.viewportSize()?.width ?? 0) >= 768 ? "PC" : "MOBILE");
  await expect(page.getByText("인증번호를 보냈어요. 문자로 받은 6자리를 넣어 주세요")).toBeVisible();
  if (wrongFirst) {
    await page.getByLabel("인증번호").fill("111111");
    await page.getByRole("button", { name: "확인", exact: true }).click();
    await expect(page.getByText("인증번호가 맞지 않아요. 다시 확인해 주세요")).toBeVisible();
  }
  await page.getByLabel("인증번호").fill("000000");
  await page.getByRole("button", { name: "확인", exact: true }).click();
}

type Account = { email: string; password: string; slug: string; name: string };

async function signup(page: Page, opts: { mailOrderNumber: string; wrongFirst?: boolean; shots?: boolean; openedOn?: string }): Promise<Account> {
  const id = uniq();
  const a: Account = { email: `partner-${id}@example.com`, password: `pw-${id}-long`, slug: `p-${id}`, name: `김${letters(id)}` };
  await page.goto("/seller/login");
  await page.getByRole("link", { name: "회원가입" }).click();
  await expect(page).toHaveURL(/\/seller\/signup$/);
  await expect(page.getByLabel("상호")).toBeDisabled();
  await fillIdentity(page, a.name);
  if (opts.shots) await shot(page, "PF-007-1");
  await verify(page, opts.wrongFirst);
  await expect(page.getByText("본인확인을 마쳤어요")).toBeVisible();
  await expect(page.getByLabel("상호")).toBeEnabled();
  await expect(page.getByLabel("상호")).toBeFocused();
  // 서버와 같은 규칙으로 먼저 거른다
  await page.getByRole("button", { name: "신청하기" }).click();
  await expect(page.getByText("상호를 적어 주세요")).toBeVisible();
  await expect(page.getByText("10자리를 모두 적어 주세요")).toBeVisible();
  await page.getByLabel("상호").fill(`별빛상사${id}`);
  await page.getByLabel("사업자등록번호").fill(businessNumber());
  await page.getByLabel("개업일").fill(opts.openedOn ?? "20200101");
  await page.getByLabel("통신판매업 신고번호").fill(opts.mailOrderNumber);
  await page.getByLabel("이메일 (로그인에 써요)").fill(a.email);
  await page.getByLabel("비밀번호", { exact: true }).fill(a.password);
  await page.getByLabel("쇼핑몰 이름").fill(`카드숍 ${id}`);
  await page.getByLabel("쇼핑몰 주소").fill(a.slug);
  if (opts.shots) await shot(page, "PF-007-2");
  const res = page.waitForResponse((r) => r.url().endsWith("/api/seller-signup/apply"));
  await page.getByRole("button", { name: "신청하기" }).click();
  expect((await res).status()).toBe(200);
  return a;
}

test("파트너스 가입 신청 → 바로 승인 → 로그인 → 비밀번호 찾기로 새 비밀번호 → 새 비밀번호로만 로그인", async ({ page }) => {
  const a = await signup(page, { mailOrderNumber: "제2024-서울강남-01234호", wrongFirst: true, shots: true });
  await expect(page.getByRole("heading", { name: "가입을 마쳤어요" })).toBeVisible();
  await expect(page.getByRole("list", { name: "진행 단계" }).locator("[aria-current=step]")).toContainText("신청 완료");
  await shot(page, "PF-007-3");

  // 가입한 계정으로 로그인
  await page.getByRole("link", { name: "로그인하기" }).click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await page.getByLabel("이메일").fill(a.email);
  await page.getByLabel("비밀번호").fill(a.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  await page.context().clearCookies();

  // 비밀번호 찾기: 대표자 본인확인 → 새 비밀번호
  await page.goto("/seller/login");
  await page.getByRole("link", { name: "비밀번호 찾기" }).click();
  await expect(page).toHaveURL(/\/seller\/password-reset$/);
  await page.getByLabel("이메일").fill(a.email);
  await page.getByLabel("쇼핑몰 주소").fill(a.slug);
  await fillIdentity(page, a.name);
  await verify(page, false, "/api/seller/password-reset/start");
  await expect(page.getByRole("heading", { name: "새 비밀번호를 정해요" })).toBeVisible();
  await expect(page.getByText(`${a.email} · 휴대폰 본인확인 완료`)).toBeVisible();
  await expect(page.getByLabel("새 비밀번호", { exact: true })).toBeFocused();
  const next = `${a.password}-new`;
  await page.getByLabel("새 비밀번호", { exact: true }).fill(next);
  await page.getByLabel("새 비밀번호 확인").fill(`${next}x`);
  await page.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  await expect(page.getByText("위에 적은 비밀번호와 달라요")).toBeVisible();
  await shot(page, "AU-004");
  await page.getByLabel("새 비밀번호 확인").fill(next);
  // 저장 중에는 두 칸을 바꿀 수 없다(보낸 값과 화면 값이 달라지지 않게)
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/seller/password-reset/complete", async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  await expect(page.getByLabel("새 비밀번호", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("새 비밀번호 확인")).toBeDisabled();
  release();
  await expect(page.getByRole("heading", { name: "비밀번호를 바꿨어요" })).toBeVisible();
  await shot(page, "AU-004-done");

  // 예전 비밀번호는 안 되고 새 비밀번호로 로그인된다
  await page.getByRole("link", { name: "로그인하기" }).click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await page.getByLabel("이메일").fill(a.email);
  await page.getByLabel("비밀번호").fill(a.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.locator("#login-err")).toBeVisible();
  await expect(page).toHaveURL(/\/seller\/login/);
  await page.getByLabel("비밀번호").fill(next);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);
});

test("통신판매업 신고번호를 확인하지 못하면 승인 대기로 받고, 걸린 항목을 알려 준다(개업일 오늘은 한국 날짜 기준)", async ({ page }) => {
  // 한국 시각 10월 4일 00:30(UTC로는 10월 3일). 개업일 「오늘(20261004)」은 미래가 아니다
  await page.clock.setFixedTime(new Date("2026-10-03T15:30:00Z"));
  await signup(page, { mailOrderNumber: "신고번호없음", openedOn: "20261004" });
  await expect(page.getByRole("heading", { name: "신청을 받았어요" })).toBeVisible();
  await expect(page.getByText("통신판매업 신고번호를 확인하지 못했어요")).toBeVisible();
  await expect(page.getByText("승인 전에는 로그인할 수 없어요.")).toBeVisible();
  await shot(page, "PF-007-3-review");
});

test("비밀번호 찾기: 대표자가 아니거나 정보가 맞지 않으면 바꿀 수 없다고 알리고 처음부터 다시 하게 한다", async ({ page }) => {
  // 데모 쇼핑몰 대표자는 이 사람이 아니다(재설정 권한을 주지 않는다)
  await page.goto("/seller/password-reset");
  await page.getByLabel("이메일").fill("demo-owner@example.com");
  await page.getByLabel("쇼핑몰 주소").fill("demo-shop");
  await fillIdentity(page, `김${letters(uniq())}`);
  // 휴대폰 폭에서는 MOBILE로 보낸다
  await page.setViewportSize({ width: 390, height: 844 });
  const started = page.waitForRequest((r) => r.url().endsWith("/api/seller/password-reset/start"));
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  expect(((await started).postDataJSON() as { person: { device: string } }).person.device).toBe("MOBILE");
  // 인증번호를 보낸 뒤에는 그 요청에 쓴 이메일·쇼핑몰 주소를 바꿀 수 없고, 「정보 다시 입력」이면 다시 바꿀 수 있다
  await expect(page.getByLabel("이메일")).toBeDisabled();
  await expect(page.getByLabel("쇼핑몰 주소")).toBeDisabled();
  await page.getByRole("button", { name: "정보 다시 입력" }).click();
  await expect(page.getByLabel("이메일")).toBeEnabled();
  await expect(page.getByLabel("쇼핑몰 주소")).toBeEnabled();
  await page.setViewportSize({ width: 1440, height: 900 });
  const res = page.waitForResponse((r) => r.url().endsWith("/api/seller/password-reset/verify"));
  await verify(page, false, "/api/seller/password-reset/start");
  expect((await res).status()).toBe(400);
  const notice = page.locator("#pa-notice");
  await expect(notice).toHaveAttribute("role", "alert");
  await expect(notice).toContainText("비밀번호를 바꿀 수 없어요");
  await expect(notice).toContainText("이메일 · 쇼핑몰 주소와 대표자 본인인지 확인해 주세요.");
  await expect(notice).toBeFocused();
  // 본인확인 칸은 비워지고 다시 받을 수 있다
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "인증번호 받기" })).toBeVisible();
  await shot(page, "AU-003-not-allowed");
});

test("비밀번호 찾기(직원 탭에서 옴): 본인확인이 등록된 직원 정보와 맞지 않으면 대표자에게 물어보라고 안내한다", async ({ page }) => {
  await page.goto("/seller/login");
  await page.getByRole("tab", { name: "직원" }).click();
  await page.getByRole("link", { name: "비밀번호 찾기" }).click();
  await expect(page).toHaveURL(/\/seller\/password-reset\?type=staff$/);
  await expect(page.getByText("직원 본인 명의의 휴대폰으로 확인해요.")).toBeVisible();
  await page.getByLabel("이메일").fill("demo-staff@example.com");
  await page.getByLabel("쇼핑몰 주소").fill("demo-shop");
  await fillIdentity(page, `김${letters(uniq())}`);
  const started = page.waitForRequest((r) => r.url().endsWith("/api/seller/password-reset/start"));
  const res = page.waitForResponse((r) => r.url().endsWith("/api/seller/password-reset/verify"));
  await verify(page, false, "/api/seller/password-reset/start");
  expect(((await started).postDataJSON() as { accountType: string }).accountType).toBe("staff");
  expect((await res).status()).toBe(400);
  await expect(page.locator("#pa-notice")).toContainText("등록된 직원 정보와 맞지 않아요. 대표자에게 물어봐 주세요");
  await shot(page, "AU-003-staff-not-allowed");
});
