import { expect, test, type Page } from "@playwright/test";

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
  await page.getByLabel("본인확인 약관에 모두 동의해요").check();
}
// 아이디·비밀번호 찾기 시작은 같은 휴대폰 하루 10회 한도라 찾기 확인마다 다른 번호를 쓴다(가짜 공급자 CI는 이름·생년월일로만 정해진다)
const randomPhone = () => `010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

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
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(page.getByLabel("인증번호")).toHaveCount(0);
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await expect(page.getByText("인증번호를 보냈어요. 문자로 받은 6자리를 넣어 주세요")).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent[1].key).toBe(sent[0].key);
  expect(sent[0].id).toBeTruthy();
  expect(sent[1].id).toBe(sent[0].id);
  await page.getByLabel("인증번호").fill("000000");
  await page.getByRole("button", { name: "확인", exact: true }).click();
}

test("본인확인 시작 응답을 잃고 다시 누르면 같은 attemptKey로 보내 같은 본인확인으로 이어 간다(가입 신청·비밀번호 찾기)", async ({ page }) => {
  // 가입 신청
  const id = uniq();
  const name = `이${letters(id)}`;
  await page.goto("/seller/signup");
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
  await expect(page.getByRole("heading", { name: "새 비밀번호를 정해요" })).toBeVisible();
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
  await page.getByRole("link", { name: "아이디 찾기" }).click();
  await expect(page).toHaveURL(/\/seller\/find-id$/);
  await expect(page.getByText("쇼핑몰 대표자 본인 명의의 휴대폰으로 확인해요.")).toBeVisible();
  await fillIdentity(page, a.name, randomPhone());
  await shot(page, "AU-011");
  const started = page.waitForRequest((r) => r.url().endsWith("/api/seller/find-id/start"));
  // 첫 시작 응답을 잃어도 다시 누르면 같은 attemptKey로 같은 본인확인에 이어진다
  const findSent = await dropFirstStart(page, "/api/seller/find-id/start");
  await retryAfterDrop(page, findSent);
  await page.unroute((u) => u.pathname === "/api/seller/find-id/start");
  expect(((await started).postDataJSON() as { accountType: string }).accountType).toBe("owner");
  await expect(page.getByRole("heading", { name: "가입한 계정을 찾았어요" })).toBeVisible();
  const row = page.getByTestId("fi-account");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(a.email);
  await expect(row).toContainText(`카드숍 `);
  // 계정이 하나면 미리 골라 둔다
  await expect(row.getByRole("radio")).toBeChecked();
  await shot(page, "AU-011-accounts");
  await page.getByRole("button", { name: "고른 계정 비밀번호 바꾸기" }).click();
  await expect(page.getByRole("heading", { name: "새 비밀번호를 정해요" })).toBeVisible();
  await expect(page.getByText(a.email)).toBeVisible();
  const next = `${a.password}-found`;
  await page.getByLabel("새 비밀번호", { exact: true }).fill(next);
  await page.getByLabel("새 비밀번호 확인").fill(next);
  await page.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  await expect(page.getByRole("heading", { name: "비밀번호를 바꿨어요" })).toBeVisible();

  await login(page, "대표자", a.email, next);
  await expect(page).toHaveURL(/\/seller\/products$/);
});

test("직원: 로그인하면 본인확인 연결 안내가 뜨고, 나중에 할 수 있고, 연결하면 아이디 찾기에서 계정이 보인다", async ({ page }) => {
  const a = await signup(page, { mailOrderNumber: "제2024-서울강남-01234호" });
  await expect(page.getByRole("heading", { name: "가입을 마쳤어요" })).toBeVisible();
  await page.getByRole("link", { name: "로그인하기" }).click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await login(page, "대표자", a.email, a.password);
  await expect(page).toHaveURL(/\/seller\/products$/);
  const id = uniq();
  const s = { email: `staff-${id}@example.com`, name: `이${letters(id)}`, password: `pw-${id}-staff`, phone: randomPhone() };
  await createStaff(page, s);
  await signOut(page);

  // 연결 전 직원은 로그인할 때마다 연결 안내로 간다(개발 서버는 가짜 본인확인이라 available: true) → 나중에 할게요면 원래 가려던 화면으로
  await login(page, "직원", s.email, s.password);
  await expect(page).toHaveURL(/\/seller\/identity-link\?next=/);
  await expect(page.getByRole("heading", { name: "본인확인으로 계정을 연결해요" })).toBeVisible();
  await expect(page.getByTestId("il-account")).toContainText(s.email);
  await expect(page.getByTestId("il-account")).toContainText(s.name);
  await expect(page.getByTestId("il-account")).toContainText(`010-****-${s.phone.slice(-4)}`);
  await expect(page.getByText("다음 로그인 때 다시 안내해요", { exact: false })).toBeVisible();
  await shot(page, "AU-012");
  await page.getByRole("button", { name: "나중에 할게요" }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);

  // 연결 전에는 아이디 찾기에서 계정이 나오지 않는다
  await signOut(page);
  await page.goto("/seller/find-id?type=staff");
  await expect(page.getByText("직원 본인 명의의 휴대폰으로 확인해요.")).toBeVisible();
  await fillIdentity(page, s.name, s.phone);
  await verify(page, false, "/api/seller/find-id/start");
  await expect(page.getByRole("heading", { name: "맞는 계정이 없어요" })).toBeVisible();
  await expect(page.getByText("등록된 직원 정보와 맞는 계정이 없어요. 대표자에게 물어봐 주세요")).toBeVisible();
  await shot(page, "AU-011-staff-empty");

  // 다시 로그인 → 등록 정보와 다른 이름은 문자 없이 거절되고 대표자에게 정보 수정을 부탁하게 안내 → 나중에 할게요
  await login(page, "직원", s.email, s.password);
  await expect(page).toHaveURL(/\/seller\/identity-link\?next=/);
  await fillIdentity(page, `박${letters(uniq())}`, s.phone);
  const mismatch = page.waitForResponse((r) => r.url().endsWith("/api/seller/me/identity/start"));
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  expect((await mismatch).status()).toBe(409);
  await expect(page.locator("#il-state")).toContainText("대표자가 등록한 직원 정보와 맞지 않아요.");
  await expect(page.locator("#il-state")).toContainText("대표자에게 정보 수정을 부탁해 주세요");
  await shot(page, "AU-012-mismatch");
  await page.getByRole("button", { name: "나중에 할게요" }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);

  // 다시 로그인 → 맞는 정보로 연결
  await signOut(page);
  await login(page, "직원", s.email, s.password);
  await expect(page).toHaveURL(/\/seller\/identity-link\?next=/);
  await fillIdentity(page, s.name, s.phone);
  // 직원 연결도 첫 시작 응답을 잃고 다시 누르면 같은 attemptKey로 같은 본인확인에 이어진다
  const linkSent = await dropFirstStart(page, "/api/seller/me/identity/start");
  await retryAfterDrop(page, linkSent);
  await page.unroute((u) => u.pathname === "/api/seller/me/identity/start");
  await expect(page.getByRole("heading", { name: "계정을 연결했어요" })).toBeVisible();
  await shot(page, "AU-012-done");
  await page.getByRole("button", { name: "계속하기" }).click();
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
  await expect(page.getByRole("heading", { name: "가입한 계정을 찾았어요" })).toBeVisible();
  await expect(page.getByTestId("fi-account")).toHaveCount(1);
  await expect(page.getByTestId("fi-account")).toContainText(s.email);

  // 연결한 직원은 비밀번호 찾기(직원 탭, 이메일·쇼핑몰 주소)로 새 비밀번호를 정할 수 있다
  await signOut(page);
  await page.goto("/seller/password-reset?type=staff");
  await page.getByLabel("이메일").fill(s.email);
  await page.getByLabel("쇼핑몰 주소").fill(a.slug);
  await fillIdentity(page, s.name, randomPhone());
  await verify(page, false, "/api/seller/password-reset/start");
  await expect(page.getByRole("heading", { name: "새 비밀번호를 정해요" })).toBeVisible();
  const next = `${s.password}-new`;
  await page.getByLabel("새 비밀번호", { exact: true }).fill(next);
  await page.getByLabel("새 비밀번호 확인").fill(next);
  await page.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  await expect(page.getByRole("heading", { name: "비밀번호를 바꿨어요" })).toBeVisible();
  await login(page, "직원", s.email, next);
  await expect(page).toHaveURL(/\/seller\/products$/);

  // 대표자가 번호를 바꾸면 연결이 풀리고, 직원이 다음에 로그인하면 「번호가 바뀌어서 본인확인을 다시 해야」 안내가 뜬다
  await signOut(page);
  await login(page, "대표자", a.email, a.password);
  await expect(page).toHaveURL(/\/seller\/products$/);
  const nextPhone = randomPhone();
  const patched = await page.evaluate(
    async ({ email, phone }) => {
      const list = (await (await fetch("/api/seller/staff")).json()) as { staff: { id: string; email: string }[] };
      const id = list.staff.find((x) => x.email === email)!.id;
      const r = await fetch(`/api/seller/staff/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
      return { status: r.status, body: await r.json() };
    },
    { email: s.email, phone: nextPhone },
  );
  expect(patched).toMatchObject({ status: 200, body: { identityLinked: false } });
  await signOut(page);
  await login(page, "직원", s.email, next);
  await expect(page).toHaveURL(/\/seller\/identity-link\?next=/);
  await expect(page.locator("#il-state")).toContainText("휴대폰 번호가 바뀌어서 본인확인을 다시 해야 아이디 · 비밀번호를 스스로 찾을 수 있어요.");
  await expect(page.getByTestId("il-account")).toContainText(`010-****-${nextPhone.slice(-4)}`);
  await expect(page.getByLabel("휴대폰번호", { exact: true })).toHaveCount(0);
  // 휴대폰 폭(390)에서도 안내 문장이 줄바꿈되어 가로로 넘치지 않는다
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot(page, "AU-012-relink");
  await page.getByRole("button", { name: "본인확인 다시 하기" }).click();
  await expect(page.getByLabel("휴대폰번호", { exact: true })).toBeVisible();
});
