import { expect, test, type Page } from "@playwright/test";
import { grantPaidPeriodInDb } from "./billingDb";

// 파트너스 가입 신청(PF-007) → 로그인 → 비밀번호 찾기(AU-003·004)를 실제 API로 끝까지 확인한다.
// 개발 서버(playwright.config.ts 「dev」)에서 돈다: 가짜 본인확인 공급자(인증번호 000000)와
// 가짜 사업자·통신판매업 조회(BUSINESS_STATUS_PROVIDER=fake, MAIL_ORDER_PROVIDER=fake → 처음 보는 번호는 정상으로 본다)가 필요하다.
// 실행마다 가입용 본인확인 6회를 쓴다(같은 IP 하루 10회 한도라 DB를 새로 만들지 않으면 한 번만 돈다. DB를 새로 만들면 풀린다).
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

async function fillIdentity(page: Page, name: string, phone = "01012345678") {
  await page.getByLabel("이름", { exact: true }).fill(name);
  await page.getByLabel("생년월일").fill("19900101");
  await page.getByRole("button", { name: "남", exact: true }).click();
  await page.getByLabel("통신사").selectOption("SKT");
  await page.getByLabel("휴대폰번호", { exact: true }).fill(phone);
  await page.getByLabel(signupScreen(page) ? "본인확인 이용 약관에 모두 동의해요" : "본인확인 이용 약관에 모두 동의합니다").check();
}
// 가입 신청(PF-007)은 공개 화면이라 해요체, 비밀번호·아이디 찾기는 관리자 인증 화면이라 합니다체
const signupScreen = (page: Page) => new URL(page.url()).pathname.startsWith("/seller/signup");
const codeSentText = (page: Page) => (signupScreen(page) ? "인증번호를 보냈어요. 문자로 받은 6자리를 넣어 주세요" : "인증번호를 보냈습니다. 문자로 받은 6자리를 입력해 주십시오");
// 파트너스 가입 필수 약관(PF-007-1). 둘 다 동의해야 인증번호를 받을 수 있다
async function agreeSignupTerms(page: Page) {
  await page.getByLabel("필수 약관에 모두 동의해요").check();
}
// 약관 동의(1단계)를 마치고 본인확인(2단계)으로 간다
async function toVerifyStep(page: Page) {
  await agreeSignupTerms(page);
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/signup\/verify$/);
}
// 아이디·비밀번호 찾기 시작은 같은 휴대폰 하루 10회 한도라 찾기 확인마다 다른 번호를 쓴다(가짜 공급자 CI는 이름·생년월일로만 정해진다)
const randomPhone = () => `010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

// 인증번호 받기 → (틀린 번호 한 번) → 000000 확인
async function verify(page: Page, wrongFirst = false, startPath = "/api/seller-signup/verification") {
  const started = page.waitForRequest((r) => r.url().endsWith(startPath) && r.method() === "POST");
  await page.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "문자 받기" }).click();
  // 본인확인 대행사에 보내는 기기 구분: 768px 이상이면 PC(구매자 가입과 같은 기준)
  const body = (await started).postDataJSON() as { device?: string; person?: { device?: string } };
  expect(body.device ?? body.person?.device).toBe((page.viewportSize()?.width ?? 0) >= 768 ? "PC" : "MOBILE");
  await expect(page.getByText(codeSentText(page))).toBeVisible();
  if (wrongFirst) {
    await page.getByLabel("인증번호").fill("111111");
    await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
    await expect(page.getByText("인증번호가 맞지 않아요. 다시 확인해 주세요")).toBeVisible();
  }
  await page.getByLabel("인증번호").fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
}

type Account = { email: string; password: string; slug: string; name: string };

async function signup(page: Page, opts: { mailOrderNumber: string; wrongFirst?: boolean; shots?: boolean; openedOn?: string; failApplyOnce?: boolean }): Promise<Account> {
  const id = uniq();
  const a: Account = { email: `partner-${id}@example.com`, password: `pw-${id}-long`, slug: `p-${id}`, name: `김${letters(id)}` };
  await page.goto("/seller/login");
  // 앞에서 하던 가입 입력이 이 탭에 남아 있으면 지운다(새로 시작)
  await page.evaluate(() => sessionStorage.clear());
  await page.getByRole("link", { name: "회원가입" }).click();
  await expect(page).toHaveURL(/\/seller\/signup$/);
  if (opts.shots) {
    // 1/5 약관 동의: 동의하지 않고 다음을 누르면 막고 안내한다
    await page.getByRole("button", { name: "다음", exact: true }).click();
    await expect(page.getByText("필수 약관에 동의해 주세요")).toBeVisible();
    await expect(page).toHaveURL(/\/seller\/signup$/);
    await page.getByLabel("파트너스 이용약관 (필수)").check();
    await page.getByLabel("개인정보 수집 · 이용 (필수)").check();
    await expect(page.getByLabel("필수 약관에 모두 동의해요")).toBeChecked();
    await shot(page, "PF-007-1");
  }
  await toVerifyStep(page);
  // 앞 단계를 건너뛰고 주소로 바로 들어오면 첫 미완료 단계(본인확인)로 보낸다
  await page.goto("/seller/signup/business");
  await expect(page).toHaveURL(/\/seller\/signup\/verify$/);
  await fillIdentity(page, a.name);
  await verify(page, opts.wrongFirst);
  await expect(page.getByText("본인확인을 마쳤어요")).toBeVisible();
  if (opts.shots) await shot(page, "PF-007-2");
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/signup\/account$/);
  // 3/5 가입 정보: 서버와 같은 규칙으로 먼저 거른다
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.getByText("이메일 주소를 다시 확인해 주세요")).toBeVisible();
  await page.getByLabel("이메일 (로그인에 써요)").fill(a.email);
  await page.getByLabel("비밀번호", { exact: true }).fill(a.password);
  await page.getByLabel("쇼핑몰 이름").fill(`카드숍 ${id}`);
  await page.getByLabel("쇼핑몰 주소").fill(a.slug);
  if (opts.shots) await shot(page, "PF-007-3");
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/signup\/business$/);
  // 4/5 사업자 정보
  await page.getByRole("button", { name: "신청하기" }).click();
  await expect(page.getByText("상호를 적어 주세요")).toBeVisible();
  await expect(page.getByText("10자리를 모두 적어 주세요")).toBeVisible();
  await page.getByLabel("상호").fill(`별빛상사${id}`);
  await page.getByLabel("사업자등록번호").fill(businessNumber());
  await page.getByLabel("개업일").fill(opts.openedOn ?? "20200101");
  await page.getByLabel("통신판매업 신고번호").fill(opts.mailOrderNumber);
  if (opts.shots) await shot(page, "PF-007-4");
  if (opts.failApplyOnce) {
    // 신청은 서버가 처리하게 두고 응답만 서버 오류로 바꾼다: 본인확인을 버리지 않고, 다시 신청하면 서버가 같은 신청 결과를 돌려준다
    await page.route((u) => u.pathname === "/api/seller-signup/apply", async (route) => {
      await route.fetch();
      return route.fulfill({ status: 500, json: { error: "internal" } });
    }, { times: 1 });
    await page.getByRole("button", { name: "신청하기" }).click();
    await page.getByRole("dialog", { name: "입력한 내용으로 가입을 신청할까요?" }).getByRole("button", { name: "신청하기" }).click();
    await expect(page.locator("#pa-notice")).toContainText("잠시 후 다시 시도해 주세요");
    await expect(page).toHaveURL(/\/seller\/signup\/business$/);
    await expect(page.getByLabel("상호")).toBeEnabled();
  }
  const res = page.waitForResponse((r) => r.url().endsWith("/api/seller-signup/apply"));
  await page.getByRole("button", { name: "신청하기" }).click();
  const sure = page.getByRole("dialog", { name: "입력한 내용으로 가입을 신청할까요?" });
  await expect(sure).toContainText("쇼핑몰 주소를 바꿀 수 없어요");
  await sure.getByRole("button", { name: "신청하기" }).click();
  expect((await res).status()).toBe(200);
  await expect(page).toHaveURL(/\/seller\/signup\/done$/);
  return a;
}

test("파트너스 가입 신청 → 바로 승인 → 로그인 → 비밀번호 찾기로 새 비밀번호 → 새 비밀번호로만 로그인", async ({ page }) => {
  const a = await signup(page, { mailOrderNumber: "제2024-서울강남-01234호", wrongFirst: true, shots: true, failApplyOnce: true });
  await expect(page.getByRole("heading", { name: "가입을 마쳤어요" })).toBeVisible();
  await expect(page.getByRole("list", { name: "진행 단계" }).locator("[aria-current=step]")).toContainText("신청 완료");
  await shot(page, "PF-007-5");

  // 가입한 계정으로 로그인
  await page.getByRole("link", { name: "로그인하기" }).click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await page.getByLabel("이메일").fill(a.email);
  await page.getByLabel("비밀번호").fill(a.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/subscription$/);
  // 새 파트너는 통합 요금제·체험 없음이라 첫 결제 전까지 잠겨 있다(#185). 잠긴 상품 화면 대신 열 수 있는 첫 메뉴 「구독 · 결제」로 간다(UX-06)
  await expect(page.getByRole("heading", { level: 1, name: "구독 · 결제" })).toBeVisible();
  // 잠긴 파트너가 상품 화면을 열면 셸이 이용 기간 종료 안내와 요금제 안내 화면을 보인다
  await page.goto("/seller/products");
  await expect(page.getByText("이용 기간이 끝났습니다", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "지금 요금제에서 사용할 수 없는 기능입니다" })).toBeVisible();
  await page.context().clearCookies();

  // 비밀번호 찾기: 대표자 본인확인 → 새 비밀번호
  await page.goto("/seller/login");
  await page.getByRole("link", { name: "아이디/비밀번호 찾기" }).click();
  await page.getByRole("navigation", { name: "아이디·비밀번호 찾기" }).getByRole("link", { name: "비밀번호 찾기" }).click();
  await expect(page).toHaveURL(/\/seller\/password-reset$/);
  await page.getByLabel("이메일").fill(a.email);
  await page.getByLabel("쇼핑몰 주소").fill(a.slug);
  await fillIdentity(page, a.name);
  // 재설정 권한 요청이 한 번 서버 오류여도 본인확인을 버리지 않고 「다시 확인」로 이어 간다
  await page.route((u) => u.pathname === "/api/seller/password-reset/verify", (route) => route.fulfill({ status: 500, json: { error: "internal" } }), { times: 1 });
  await verify(page, false, "/api/seller/password-reset/start");
  await expect(page.locator("#pa-notice")).toContainText("잠시 후 다시 시도해 주십시오");
  await expect(page.locator("#idv-name")).toHaveValue(a.name);
  // 다시 확인한 요청은 서버가 권한을 발급했는데 응답만 끊긴다: 한 번 더 누르면 서버가 같은 본인확인에 같은 권한을 돌려줘 이어 간다(#170)
  await page.route(
    (u) => u.pathname === "/api/seller/password-reset/verify",
    async (route) => {
      await route.fetch();
      return route.abort("connectionreset");
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "결과 다시 확인하기", exact: true }).click();
  await expect(page.locator("#pa-notice")).toContainText("연결이 끊겼습니다");
  await page.getByRole("button", { name: "결과 다시 확인하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "새 비밀번호 설정" })).toBeVisible();
  await expect(page.getByText(`${a.email} · 휴대폰 본인확인 완료`)).toBeVisible();
  await expect(page.getByLabel("새 비밀번호", { exact: true })).toBeFocused();
  const next = `${a.password}-new`;
  await page.getByLabel("새 비밀번호", { exact: true }).fill(next);
  await page.getByLabel("새 비밀번호 확인").fill(`${next}x`);
  await page.getByRole("button", { name: "비밀번호 변경", exact: true }).click();
  await expect(page.getByText("위에 입력한 비밀번호와 다릅니다")).toBeVisible();
  await shot(page, "AU-004");
  await page.getByLabel("새 비밀번호 확인").fill(next);
  // 저장 중에는 두 칸을 바꿀 수 없다(보낸 값과 화면 값이 달라지지 않게)
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/seller/password-reset/complete", async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole("button", { name: "비밀번호 변경", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "비밀번호 변경" }).click();
  await expect(page.getByLabel("새 비밀번호", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("새 비밀번호 확인")).toBeDisabled();
  release();
  await expect(page.getByRole("heading", { name: "비밀번호를 변경했습니다" })).toBeVisible();
  await shot(page, "AU-004-done");

  // 예전 비밀번호는 안 되고 새 비밀번호로 로그인된다
  await page.getByRole("link", { name: "로그인", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await page.getByLabel("이메일").fill(a.email);
  await page.getByLabel("비밀번호").fill(a.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.locator("#login-err")).toBeVisible();
  await expect(page).toHaveURL(/\/seller\/login/);
  await page.getByLabel("비밀번호").fill(next);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/subscription$/);
});

// 시작 요청은 서버가 처리하게 두고 첫 응답만 끊는다(서버에서는 문자를 보내고 횟수를 쓴 상태). 다시 누르면 같은 attemptKey로 보내고
// 서버는 같은 본인확인을 돌려준다(문자·하루 횟수를 다시 쓰지 않는 것은 integration sellerSignup·passwordReset에서 확인).
async function dropFirstStart(page: Page, path: string) {
  const sent: { key: string; id?: string }[] = [];
  await page.route((u) => u.pathname === path, async (route) => {
    const body = route.request().postDataJSON() as { attemptKey: string };
    const res = await route.fetch();
    const json = (await res.json()) as { verificationId?: string };
    sent.push({ key: body.attemptKey, id: json.verificationId });
    return sent.length === 1 ? route.abort("connectionreset") : route.fulfill({ response: res });
  });
  return sent;
}

async function retryAfterDrop(page: Page, sent: { key: string; id?: string }[]) {
  await page.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "문자 받기" }).click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(page.getByLabel("인증번호")).toHaveCount(0);
  await page.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "문자 받기" }).click();
  await expect(page.getByText(codeSentText(page))).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent[1].key).toBe(sent[0].key);
  expect(sent[0].id).toBeTruthy();
  expect(sent[1].id).toBe(sent[0].id);
  await page.getByLabel("인증번호").fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
}

test("본인확인 시작 응답을 잃고 다시 누르면 같은 attemptKey로 보내 같은 본인확인으로 이어 간다(가입 신청·비밀번호 찾기)", async ({ page }) => {
  // 가입 신청
  const id = uniq();
  const name = `이${letters(id)}`;
  await page.goto("/seller/signup");
  await toVerifyStep(page);
  await fillIdentity(page, name);
  const signupSent = await dropFirstStart(page, "/api/seller-signup/verification");
  await retryAfterDrop(page, signupSent);
  await expect(page.getByText("본인확인을 마쳤어요")).toBeVisible();
  await page.unroute((u) => u.pathname === "/api/seller-signup/verification");

  // 비밀번호 찾기: 가입을 마친 계정으로
  const a = await signup(page, { mailOrderNumber: "제2024-서울강남-05678호" });
  await page.context().clearCookies();
  await page.goto("/seller/password-reset");
  await page.getByLabel("이메일").fill(a.email);
  await page.getByLabel("쇼핑몰 주소").fill(a.slug);
  await fillIdentity(page, a.name);
  const resetSent = await dropFirstStart(page, "/api/seller/password-reset/start");
  await retryAfterDrop(page, resetSent);
  await expect(page.getByRole("heading", { name: "새 비밀번호 설정" })).toBeVisible();
});

test("가입 신청 단계: 동의 없이 다음을 누르면 막고, 앞 단계를 건너뛴 주소는 첫 미완료 단계로 보내며, 본인확인 입력은 이전 단계·새로고침에도 남는다", async ({ page }) => {
  await page.goto("/seller/signup");
  await page.evaluate(() => sessionStorage.clear());
  // 1/5: 동의하지 않으면 다음으로 갈 수 없다
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.locator("#su-terms-err")).toHaveText("필수 약관에 동의해 주세요");
  await expect(page).toHaveURL(/\/seller\/signup$/);
  // 앞 단계를 건너뛴 주소는 첫 미완료 단계로
  await page.goto("/seller/signup/account");
  await expect(page).toHaveURL(/\/seller\/signup$/);
  await expect(page.getByText("앞 단계부터 진행해 주세요")).toBeVisible();
  await toVerifyStep(page);
  await expect(page.getByTestId("signup-step-count")).toHaveText("2 / 5");
  // 2/5: 입력한 칸은 이전 단계로 갔다 와도, 새로고침해도 남는다
  const who = `윤${letters(uniq())}`;
  await fillIdentity(page, who);
  await page.getByRole("button", { name: "이전 단계" }).click();
  await expect(page).toHaveURL(/\/seller\/signup$/);
  await expect(page.getByLabel("필수 약관에 모두 동의해요")).toBeChecked();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.locator("#idv-name")).toHaveValue(who);
  await page.reload();
  await expect(page.locator("#idv-name")).toHaveValue(who);
  await expect(page).toHaveURL(/\/seller\/signup\/verify$/);
  // 본인확인 전에는 다음으로 갈 수 없다
  await expect(page.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
});

test("가입 신청: 화면의 약관 버전이 서버와 다르면 문자를 보내지 않고, 동의를 비워 다시 동의하게 한다", async ({ page }) => {
  // 약관이 바뀌기 전에 열어 둔 화면: 처음 받은 화면의 약관 버전만 예전 값으로 바꿔 둔다(그 뒤 화면 데이터 요청은 그대로 서버 값)
  await page.route(
    (u) => u.pathname === "/seller/signup",
    async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const res = await route.fetch();
      return route.fulfill({ response: res, body: (await res.text()).replace(/\d{4}-\d{2}-\d{2}\.v\d+/g, "2026-01-01.v0") });
    },
    { times: 1 },
  );
  await page.goto("/seller/signup");
  const who = `최${letters(uniq())}`;
  await toVerifyStep(page);
  await fillIdentity(page, who);
  const stale = page.waitForRequest((r) => r.url().endsWith("/api/seller-signup/verification") && r.method() === "POST");
  const refused = page.waitForResponse((r) => r.url().endsWith("/api/seller-signup/verification") && r.request().method() === "POST");
  // 거절되면 화면 데이터를 새로 받아 서버의 지금 약관 버전으로 바꾼다(열어 둔 예전 화면이 같은 버전을 계속 보내지 않게)
  const refreshed = page.waitForRequest((r) => new URL(r.url()).pathname === "/seller/signup" && r.headers()["rsc"] === "1");
  await page.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "문자 받기" }).click();
  expect((await stale).postDataJSON()).toMatchObject({ termsVersion: "2026-01-01.v0", privacyVersion: "2026-01-01.v0" });
  const refusedRes = await refused;
  expect(refusedRes.status()).toBe(409);
  // 서버는 거절하면서 지금 약관 버전을 알려 준다
  const current = (await refusedRes.json()) as { termsVersion: string; privacyVersion: string };
  expect(current.termsVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.v\d+$/);
  await refreshed;
  // 약관 동의 단계로 돌아가 안내한다
  await expect(page).toHaveURL(/\/seller\/signup$/);
  await expect(page.locator("#su-terms-err")).toHaveText("약관이 바뀌었어요. 다시 확인해 주세요");
  await expect(page.getByLabel("필수 약관에 모두 동의해요")).not.toBeChecked();
  await expect(page.getByLabel("필수 약관에 모두 동의해요")).toBeFocused();
  await expect(page.getByText("인증번호를 보냈어요", { exact: false })).toHaveCount(0);
  await shot(page, "PF-007-1-outdated");
  // 다시 동의하면 입력한 본인확인 칸이 그대로 남아 있고, 서버의 지금 버전으로 보내 이어 간다
  await toVerifyStep(page);
  await expect(page.locator("#idv-name")).toHaveValue(who);
  await expect(page.locator("#su-terms-err")).toHaveCount(0);
  const again = page.waitForRequest((r) => r.url().endsWith("/api/seller-signup/verification") && r.method() === "POST");
  const accepted = page.waitForResponse((r) => r.url().endsWith("/api/seller-signup/verification") && r.request().method() === "POST");
  await verify(page);
  expect((await again).postDataJSON()).toMatchObject({ termsVersion: current.termsVersion, privacyVersion: current.privacyVersion });
  expect((await accepted).status()).toBe(200);
  await expect(page.getByText("본인확인을 마쳤어요")).toBeVisible();
});

test("통신판매업 신고번호를 확인하지 못하면 승인 대기로 받고, 걸린 항목을 알려 준다(개업일 오늘은 한국 날짜 기준)", async ({ page }) => {
  // 한국 시각 10월 4일 00:30(UTC로는 10월 3일). 개업일 「오늘(20261004)」은 미래가 아니다
  await page.clock.setFixedTime(new Date("2026-10-03T15:30:00Z"));
  await signup(page, { mailOrderNumber: "신고번호없음", openedOn: "20261004" });
  await expect(page.getByRole("heading", { name: "신청을 받았어요" })).toBeVisible();
  await expect(page.getByText("통신판매업 신고번호를 확인하지 못했어요")).toBeVisible();
  await expect(page.getByText("그 전에는 로그인할 수 없어요.")).toBeVisible();
  await shot(page, "PF-007-5-review");
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
  await page.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "문자 받기" }).click();
  expect(((await started).postDataJSON() as { person: { device: string } }).person.device).toBe("MOBILE");
  // 인증번호를 보낸 뒤에는 그 요청에 쓴 이메일·쇼핑몰 주소를 바꿀 수 없고, 「정보 다시 입력」이면 다시 바꿀 수 있다
  await expect(page.getByLabel("이메일")).toBeDisabled();
  await expect(page.getByLabel("쇼핑몰 주소")).toBeDisabled();
  await page.getByRole("button", { name: "정보 다시 쓰기" }).click();
  await expect(page.getByLabel("이메일")).toBeEnabled();
  await expect(page.getByLabel("쇼핑몰 주소")).toBeEnabled();
  await page.setViewportSize({ width: 1440, height: 900 });
  const res = page.waitForResponse((r) => r.url().endsWith("/api/seller/password-reset/verify"));
  await verify(page, false, "/api/seller/password-reset/start");
  expect((await res).status()).toBe(400);
  const notice = page.locator("#pa-notice");
  await expect(notice).toHaveAttribute("role", "alert");
  await expect(notice).toContainText("비밀번호를 변경할 수 없습니다");
  await expect(notice).toContainText("입력한 이메일과 쇼핑몰 주소가 맞는지, 대표자 본인 명의의 휴대폰인지 확인해 주십시오.");
  await expect(notice).toBeFocused();
  // 본인확인 칸은 비워지고 다시 받을 수 있다
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "인증번호 문자 받기" })).toBeVisible();
  await shot(page, "AU-003-not-allowed");
});

test("비밀번호 찾기(직원 탭에서 옴): 본인확인이 등록된 직원 정보와 맞지 않으면 대표자에게 물어보라고 안내한다", async ({ page }) => {
  await page.goto("/seller/login");
  await page.getByRole("tab", { name: "직원" }).click();
  await page.getByRole("link", { name: "아이디/비밀번호 찾기" }).click();
  await page.getByRole("navigation", { name: "아이디·비밀번호 찾기" }).getByRole("link", { name: "비밀번호 찾기" }).click();
  await expect(page).toHaveURL(/\/seller\/password-reset\?type=staff$/);
  await expect(page.getByText("직원 본인 명의의 휴대폰으로 확인합니다.")).toBeVisible();
  await page.getByLabel("이메일").fill("demo-staff@example.com");
  await page.getByLabel("쇼핑몰 주소").fill("demo-shop");
  await fillIdentity(page, `김${letters(uniq())}`);
  const started = page.waitForRequest((r) => r.url().endsWith("/api/seller/password-reset/start"));
  const res = page.waitForResponse((r) => r.url().endsWith("/api/seller/password-reset/verify"));
  await verify(page, false, "/api/seller/password-reset/start");
  expect(((await started).postDataJSON() as { accountType: string }).accountType).toBe("staff");
  expect((await res).status()).toBe(400);
  await expect(page.locator("#pa-notice")).toContainText("등록된 직원 정보와 맞지 않습니다. 대표자에게 문의해 주십시오");
  await shot(page, "AU-003-staff-not-allowed");
});

// 대표자로 로그인한 화면에서 직원 계정을 만든다(SA-100 화면은 아직 없어 API로 만든다)
async function createStaff(page: Page, staff: { email: string; name: string; password: string; phone: string }) {
  const status = await page.evaluate(async (body) => {
    const r = await fetch("/api/seller/staff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.status;
  }, { ...staff, permissions: ["PRODUCT_MANAGE"] });
  expect(status).toBe(201);
}

// 로그인 화면이 남아 있으면 로그아웃 뒤 401로 로그인 화면 이동이 다음 이동과 겹치므로 빈 화면으로 먼저 옮긴다
async function signOut(page: Page) {
  await page.goto("about:blank");
  await page.context().clearCookies();
}

async function login(page: Page, tab: "대표자" | "직원", email: string, password: string) {
  await page.goto("/seller/login");
  await page.getByRole("tab", { name: tab }).click();
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
}

test("아이디 찾기(대표자): 본인확인하면 가입한 이메일과 쇼핑몰 이름을 보여 주고, 고른 계정 비밀번호를 바꿀 수 있다", async ({ page }) => {
  const a = await signup(page, { mailOrderNumber: "제2024-서울강남-01234호" });
  await expect(page.getByRole("heading", { name: "가입을 마쳤어요" })).toBeVisible();
  await page.context().clearCookies();

  await page.goto("/seller/login");
  await page.getByRole("link", { name: "아이디/비밀번호 찾기" }).click();
  await expect(page).toHaveURL(/\/seller\/find-id$/);
  await expect(page.getByText("쇼핑몰 대표자 본인 명의의 휴대폰으로 확인합니다.")).toBeVisible();
  await fillIdentity(page, a.name, randomPhone());
  await shot(page, "AU-011");
  const started = page.waitForRequest((r) => r.url().endsWith("/api/seller/find-id/start"));
  // 첫 시작 응답을 잃어도 다시 누르면 같은 attemptKey로 같은 본인확인에 이어진다
  const findSent = await dropFirstStart(page, "/api/seller/find-id/start");
  // 본인확인 뒤 계정 목록 요청이 한 번 서버 오류여도 본인확인을 버리지 않고 「다시 확인」로 이어 간다
  await page.route((u) => u.pathname === "/api/seller/find-id/accounts", (route) => route.fulfill({ status: 500, json: { error: "internal" } }), { times: 1 });
  await retryAfterDrop(page, findSent);
  await page.unroute((u) => u.pathname === "/api/seller/find-id/start");
  await expect(page.locator("#pa-notice")).toContainText("잠시 후 다시 시도해 주십시오");
  await expect(page.locator("#idv-name")).toHaveValue(a.name);
  await shot(page, "AU-011-retry");
  await page.getByRole("button", { name: "결과 다시 확인하기", exact: true }).click();
  expect(((await started).postDataJSON() as { accountType: string }).accountType).toBe("owner");
  await expect(page.getByRole("heading", { name: "가입한 계정을 찾았습니다" })).toBeVisible();
  const row = page.getByTestId("fi-account");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(a.email);
  await expect(row).toContainText(`카드숍 `);
  // 계정이 하나면 미리 골라 둔다
  await expect(row.getByRole("radio")).toBeChecked();
  await shot(page, "AU-011-accounts");
  // 재설정 권한 응답을 놓치면 고른 계정 화면에 남아 다시 누를 수 있고, 다시 누르면 서버가 권한을 다시 줘 이어 간다
  let resetCalls = 0;
  await page.route((u) => u.pathname === "/api/seller/find-id/reset", async (route) => {
    resetCalls += 1;
    const res = await route.fetch();
    return resetCalls === 1 ? route.abort("connectionreset") : route.fulfill({ response: res });
  });
  await page.getByRole("button", { name: "선택한 계정의 비밀번호 바꾸기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "비밀번호 바꾸기" }).click();
  await expect(page.locator("#pa-notice")).toContainText("연결이 끊겼습니다");
  await expect(page.getByTestId("fi-account")).toHaveCount(1);
  await page.getByRole("button", { name: "선택한 계정의 비밀번호 바꾸기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "비밀번호 바꾸기" }).click();
  await expect(page.getByRole("heading", { name: "새 비밀번호 설정" })).toBeVisible();
  expect(resetCalls).toBe(2);
  await page.unroute((u) => u.pathname === "/api/seller/find-id/reset");
  await expect(page.getByText(a.email)).toBeVisible();
  const next = `${a.password}-found`;
  await page.getByLabel("새 비밀번호", { exact: true }).fill(next);
  await page.getByLabel("새 비밀번호 확인").fill(next);
  // 저장은 서버에서 끝났는데 응답만 끊긴다: 다시 누르면 권한이 이미 쓰여 invalid_grant가 오지만,
  // 처음부터(유료 본인확인) 보내지 않고 방금 정한 비밀번호로 로그인해 보게 한다
  // 두 번째 요청은 프록시가 코드 없는 503으로 답한다: 본인확인 준비 중(identity_unavailable)이 아니므로 여전히 불분명으로 본다
  let completeCalls = 0;
  await page.route((u) => u.pathname === "/api/seller/password-reset/complete", async (route) => {
    completeCalls += 1;
    if (completeCalls === 2) return route.fulfill({ status: 503, contentType: "text/html", body: "<html>Service Unavailable</html>" });
    if (completeCalls > 2) return route.continue();
    await route.fetch();
    return route.abort("connectionreset");
  });
  await page.getByRole("button", { name: "비밀번호 변경", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "비밀번호 변경" }).click();
  // 응답을 놓친 그 자리에서 바뀌었을 수 있다고 알리고 로그인 안내를 보여 준다
  await expect(page.locator("#pw-notice")).toContainText("비밀번호가 변경되었을 수 있습니다.");
  await expect(page.locator("#pw-notice").getByRole("link", { name: "로그인", exact: true })).toBeVisible();
  await shot(page, "AU-004-maybe");
  const proxied = page.waitForResponse((r) => r.url().endsWith("/api/seller/password-reset/complete") && r.status() === 503);
  await page.getByRole("button", { name: "비밀번호 변경", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "비밀번호 변경" }).click();
  await proxied;
  await expect(page.locator("#pw-notice")).toContainText("비밀번호가 변경되었을 수 있습니다.");
  await page.getByRole("button", { name: "비밀번호 변경", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "비밀번호 변경" }).click();
  await expect(page.locator("#pw-maybe")).toContainText("비밀번호가 바뀌었는지 확인하지 못했습니다.");
  await expect(page.getByLabel("인증번호")).toHaveCount(0);
  expect(completeCalls).toBe(3);
  await page.unroute((u) => u.pathname === "/api/seller/password-reset/complete");
  await page.getByRole("link", { name: "로그인", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await page.getByLabel("이메일").fill(a.email);
  await page.getByLabel("비밀번호").fill(next);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/subscription$/);
});

test("직원: 로그인하면 본인확인 연결 안내가 뜨고, 나중에 할 수 있고, 연결하면 아이디 찾기에서 계정이 보인다", async ({ page }) => {
  const a = await signup(page, { mailOrderNumber: "제2024-서울강남-01234호" });
  await expect(page.getByRole("heading", { name: "가입을 마쳤어요" })).toBeVisible();
  await page.getByRole("link", { name: "로그인하기" }).click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await login(page, "대표자", a.email, a.password);
  await expect(page).toHaveURL(/\/seller\/subscription$/);
  const id = uniq();
  const s = { email: `staff-${id}@example.com`, name: `이${letters(id)}`, password: `pw-${id}-staff`, phone: randomPhone() };
  // 직원 관리는 잠긴 파트너가 쓸 수 없다: 시험 DB에 결제한 이용 기간을 넣는다
  await grantPaidPeriodInDb(a.email);
  await createStaff(page, s);
  await signOut(page);

  // 연결 전 직원은 로그인할 때마다 연결 안내로 간다(개발 서버는 가짜 본인확인이라 available: true) → 나중에 할게요면 원래 가려던 화면으로
  await login(page, "직원", s.email, s.password);
  await expect(page).toHaveURL(/\/seller\/identity-link\?next=/);
  await expect(page.getByRole("heading", { name: "휴대폰 확인으로 내 계정 확인하기" })).toBeVisible();
  await expect(page.getByTestId("il-account")).toContainText(s.email);
  await expect(page.getByTestId("il-account")).toContainText(s.name);
  await expect(page.getByTestId("il-account")).toContainText(`휴대폰 끝자리 ${s.phone.slice(-4)}`);
  await expect(page.getByText("다음 로그인 때 다시 안내합니다", { exact: false })).toBeVisible();
  await shot(page, "AU-012");
  await page.getByRole("button", { name: "나중에 하기" }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  // 원래 가려던 곳이 있으면 「다른 계정으로 로그인」해도 그곳을 잃지 않는다
  await page.goto("/seller/identity-link?next=%2Fseller%2Forders");
  await page.getByRole("link", { name: "다른 계정으로 로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/login\?type=staff&next=%2Fseller%2Forders$/);
  await page.getByLabel("이메일").fill(s.email);
  await page.getByLabel("비밀번호").fill(s.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/identity-link\?next=%2Fseller%2Forders/);
  await page.getByRole("button", { name: "나중에 하기" }).click();
  await expect(page).toHaveURL(/\/seller\/orders$/);

  // 연결 전에는 아이디 찾기에서 계정이 나오지 않는다
  await signOut(page);
  await page.goto("/seller/find-id?type=staff");
  await expect(page.getByText("직원 본인 명의의 휴대폰으로 확인합니다.")).toBeVisible();
  await fillIdentity(page, s.name, s.phone);
  await verify(page, false, "/api/seller/find-id/start");
  await expect(page.getByRole("heading", { name: "맞는 계정이 없습니다" })).toBeVisible();
  await expect(page.getByText("등록된 직원 정보와 맞는 계정이 없습니다. 대표자에게 문의해 주십시오")).toBeVisible();
  await shot(page, "AU-011-staff-empty");

  // 다시 로그인 → 등록 정보와 다른 이름은 문자 없이 거절되고 대표자에게 정보 수정을 부탁하게 안내 → 나중에 할게요
  await login(page, "직원", s.email, s.password);
  await expect(page).toHaveURL(/\/seller\/identity-link\?next=/);
  await fillIdentity(page, `박${letters(uniq())}`, s.phone);
  const mismatch = page.waitForResponse((r) => r.url().endsWith("/api/seller/me/identity/start"));
  await page.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "문자 받기" }).click();
  expect((await mismatch).status()).toBe(409);
  await expect(page.locator("#il-state")).toContainText("대표자가 등록한 정보와 다릅니다.");
  await expect(page.locator("#il-state")).toContainText("대표자에게 정보를 고쳐 달라고 요청해 주십시오");
  await shot(page, "AU-012-mismatch");
  await page.getByRole("button", { name: "나중에 하기" }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);

  // 다시 로그인 → 맞는 정보로 연결
  await signOut(page);
  await login(page, "직원", s.email, s.password);
  await expect(page).toHaveURL(/\/seller\/identity-link\?next=/);
  await fillIdentity(page, s.name, s.phone);
  // 직원 연결도 첫 시작 응답을 잃고 다시 누르면 같은 attemptKey로 같은 본인확인에 이어진다
  const linkSent = await dropFirstStart(page, "/api/seller/me/identity/start");
  // 연결(link) 첫 요청은 저장되지 않은 서버 오류: 본인확인을 버리지 않고 상태를 다시 읽어 아직 아니면 「다시 확인」를 준다.
  // 두 번째는 서버에 저장되고 응답만 끊긴다: 상태를 다시 읽어 완료로 이어 간다
  let linkCalls = 0;
  await page.route((u) => u.pathname === "/api/seller/me/identity/link", async (route) => {
    linkCalls += 1;
    if (linkCalls === 1) return route.fulfill({ status: 500, json: { error: "internal" } });
    await route.fetch();
    return route.abort("connectionreset");
  });
  await retryAfterDrop(page, linkSent);
  await page.unroute((u) => u.pathname === "/api/seller/me/identity/start");
  // 본인확인이 끝나면 자동으로 잇지 않고 먼저 묻는다
  await page.getByRole("dialog", { name: "이 휴대폰으로 내 계정을 연결하시겠습니까?" }).getByRole("button", { name: "연결하기" }).click();
  await expect(page.locator("#pa-notice")).toContainText("확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오");
  await expect(page.locator("#idv-name")).toHaveValue(s.name);
  await page.getByRole("button", { name: "결과 다시 확인하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "계정을 연결했습니다" })).toBeVisible();
  expect(linkCalls).toBe(2);
  await page.unroute((u) => u.pathname === "/api/seller/me/identity/link");
  await shot(page, "AU-012-done");
  await page.getByRole("button", { name: "계속", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);

  // 연결한 뒤에는 로그인해도 안내가 뜨지 않는다
  await signOut(page);
  await login(page, "직원", s.email, s.password);
  await expect(page).toHaveURL(/\/seller\/products$/);

  // 아이디 찾기(직원 탭)에서 이 직원 계정이 쇼핑몰 이름과 함께 보인다
  await signOut(page);
  await page.goto("/seller/find-id?type=staff");
  await fillIdentity(page, s.name, randomPhone());
  const started = page.waitForRequest((r) => r.url().endsWith("/api/seller/find-id/start"));
  await verify(page, false, "/api/seller/find-id/start");
  expect(((await started).postDataJSON() as { accountType: string }).accountType).toBe("staff");
  await expect(page.getByRole("heading", { name: "가입한 계정을 찾았습니다" })).toBeVisible();
  await expect(page.getByTestId("fi-account")).toHaveCount(1);
  await expect(page.getByTestId("fi-account")).toContainText(s.email);

  // 연결한 직원은 비밀번호 찾기(직원 탭, 이메일·쇼핑몰 주소)로 새 비밀번호를 정할 수 있다
  await signOut(page);
  await page.goto("/seller/password-reset?type=staff");
  await page.getByLabel("이메일").fill(s.email);
  await page.getByLabel("쇼핑몰 주소").fill(a.slug);
  await fillIdentity(page, s.name, randomPhone());
  await verify(page, false, "/api/seller/password-reset/start");
  await expect(page.getByRole("heading", { name: "새 비밀번호 설정" })).toBeVisible();
  const next = `${s.password}-new`;
  await page.getByLabel("새 비밀번호", { exact: true }).fill(next);
  await page.getByLabel("새 비밀번호 확인").fill(next);
  await page.getByRole("button", { name: "비밀번호 변경", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "비밀번호 변경" }).click();
  await expect(page.getByRole("heading", { name: "비밀번호를 변경했습니다" })).toBeVisible();
  await login(page, "직원", s.email, next);
  await expect(page).toHaveURL(/\/seller\/products$/);

  // 대표자가 번호를 바꾸면 연결이 풀리고, 직원이 다음에 로그인하면 「번호가 바뀌어서 본인확인을 다시 해야」 안내가 뜬다
  await signOut(page);
  await login(page, "대표자", a.email, a.password);
  await expect(page).toHaveURL(/\/seller\/products$/);
  // 직원 계정 화면(SA-100)의 수정 창에서 번호를 바꾼다: 연결된 직원이라 다시 본인확인해야 한다고 알려 준다
  const nextPhone = `011${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  await page.goto("/seller/staff");
  await page.getByRole("button", { name: `${s.name} 정보 · 권한 수정` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("연결됨", { exact: true })).toBeVisible();
  await dialog.getByLabel("휴대폰 번호").fill(nextPhone);
  await expect(dialog.getByText("번호를 바꾸면 직원이 본인확인을 다시 해야 합니다.")).toBeVisible();
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText("다음 로그인 때 본인확인을 다시 안내합니다", { exact: false })).toBeVisible();
  await signOut(page);
  await login(page, "직원", s.email, next);
  await expect(page).toHaveURL(/\/seller\/identity-link\?next=/);
  await expect(page.locator("#il-state")).toContainText("휴대폰 번호가 바뀌어 본인확인을 다시 해야 아이디 · 비밀번호를 직접 찾을 수 있습니다.");
  await expect(page.getByTestId("il-account")).toContainText(`휴대폰 끝자리 ${nextPhone.slice(-4)}`);
  // 앞자리는 서버가 주지 않으므로 010 같은 앞자리를 지어내 보여 주지 않는다(011 번호 직원)
  await expect(page.getByTestId("il-account")).not.toContainText("010-");
  await expect(page.getByLabel("휴대폰번호", { exact: true })).toHaveCount(0);
  // 휴대폰 폭(390)에서도 안내 문장이 줄바꿈되어 가로로 넘치지 않는다
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot(page, "AU-012-relink");
  await page.getByRole("button", { name: "휴대폰 확인 다시 하기" }).click();
  await expect(page.getByLabel("휴대폰번호", { exact: true })).toBeVisible();
});
