import { expect, test, type Page } from "@playwright/test";
import { BUYER_SIGNUP_MESSAGES } from "../../lib/server/buyers/signup";
import { IDENTITY_ERROR_MESSAGES } from "../../lib/server/identity/messages";

// SH-011 구매자 회원가입 흐름 — 개발 서버(가짜 본인확인 공급자, 인증번호 000000)에서 돈다(playwright.config.ts 「dev」).
// 성공 흐름은 실제 API로, 만들기 어려운 실패(이미 가입·닉네임 중복·여러 번 틀림 등)는 API 응답을 서버 문구 그대로 흉내 내 확인한다.
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const SLUG = "demo-shop";
const API = `/api/shop/${SLUG}/signup`;

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

// 실행마다 다른 사람(가짜 공급자는 이름·생년월일로 사람을 가른다)·휴대폰(같은 쇼핑몰에 한 번만 가입)·이메일·닉네임
const uniq = () => Date.now().toString(36).slice(-6);
const uniqPhone = () => `010${String(Date.now() % 1e8).padStart(8, "0")}`;

async function fillIdentity(page: Page, name: string, phone = "01012345678") {
  await page.getByLabel("이름", { exact: true }).fill(name);
  await page.getByLabel("생년월일").fill("19990101");
  await page.getByRole("button", { name: "여", exact: true }).click();
  await page.getByLabel("통신사").selectOption("KT");
  await page.getByLabel("휴대폰번호", { exact: true }).fill(phone);
  await page.getByLabel("본인확인 약관에 모두 동의해요").check();
}

async function fillAccount(page: Page, id: string, nickname: string) {
  await page.getByLabel("아이디 (이메일)").fill(`buyer-${id}@example.com`);
  await page.getByLabel("비밀번호").fill(`pw-${id}-long`);
  await page.getByLabel("방송 닉네임").fill(nickname);
  await page.getByLabel("약관에 모두 동의해요", { exact: true }).check();
}

type Reply = { status: number; body: unknown };
// 네 API를 흉내 낸다. 넘기지 않은 단계는 성공으로 답한다.
async function mockApi(page: Page, r: { verification?: Reply; resend?: Reply; confirm?: Reply; signup?: Reply } = {}) {
  const ok = (x: Reply | undefined, fallback: unknown, status = 200) => x ?? { status, body: fallback };
  const routes: [string, Reply][] = [
    [`${API}/verification/resend`, ok(r.resend, { ok: true })],
    [`${API}/verification/confirm`, ok(r.confirm, { ok: true })],
    [`${API}/verification`, ok(r.verification, { verificationId: "00000000-0000-4000-8000-000000000000" })],
    [API, ok(r.signup, { ok: true }, 201)],
  ];
  for (const [path, reply] of routes) {
    await page.route((u) => u.pathname === path, (route) => route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) }));
  }
}

const fail = (status: number, error: string, message: string): Reply => ({ status, body: { error, message } });

async function toVerified(page: Page, name = "김구매") {
  await fillIdentity(page, name);
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await page.getByLabel("인증번호").fill("000000");
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.getByText("본인확인을 마쳤어요")).toBeVisible();
}

test("본인확인 → 틀린 인증번호 → 맞는 인증번호 → 가입까지 실제로 된다", async ({ page }) => {
  const id = uniq();
  const phone = uniqPhone();
  await page.goto(`/shop/${SLUG}/signup`);
  await expect(page.getByRole("heading", { name: "회원가입" })).toBeVisible();
  // 본인확인 전에는 계정 칸을 쓸 수 없다
  await expect(page.getByLabel("아이디 (이메일)")).toBeDisabled();
  await expect(page.getByRole("button", { name: "인증번호 받기" })).toBeDisabled();
  await shot(page, "SH-011");

  await fillIdentity(page, `구매${id}`, phone);
  const sent = page.waitForResponse((r) => r.url().endsWith(`${API}/verification`));
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  expect((await sent).status()).toBe(200);
  await expect(page.getByText("인증번호를 보냈어요. 문자로 받은 6자리를 넣어 주세요")).toBeVisible();
  // 인증번호를 받은 뒤에는 인적사항을 고칠 수 없다(고치려면 「정보 다시 입력」)
  await expect(page.getByLabel("이름", { exact: true })).toBeDisabled();

  await page.getByLabel("인증번호").fill("111111");
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: IDENTITY_ERROR_MESSAGES.wrong_code })).toBeVisible();
  await expect(page.getByLabel("인증번호")).toHaveAttribute("aria-invalid", "true");
  await shot(page, "SH-011-wrong-code");

  await page.getByLabel("인증번호").fill("000000");
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.getByText("본인확인을 마쳤어요")).toBeVisible();
  await expect(page.locator("#v-name")).toHaveValue(`구매${id}`);
  await expect(page.locator("#v-phone")).toHaveValue(`${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`);
  await expect(page.getByText("본인확인에서 받은 정보라 여기서는 고칠 수 없어요")).toBeVisible();

  await fillAccount(page, id, `별${id}`);
  await shot(page, "SH-011-verified");
  const done = page.waitForResponse((r) => r.url().endsWith(API) && r.request().method() === "POST");
  await page.getByRole("button", { name: "가입하기" }).click();
  expect((await done).status()).toBe(201);
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
  await expect(page.getByText(`이제 주문할 수 있어요. 방송에서는 별${id} 닉네임으로 보여요.`)).toBeVisible();
  await shot(page, "SH-011-done");
});

test("생년월일이 없는 날짜면 요청을 보내지 않고 칸 아래에 알려 준다", async ({ page }) => {
  let calls = 0;
  await page.route((u) => u.pathname.startsWith(API), (route) => {
    calls++;
    return route.abort();
  });
  await page.goto(`/shop/${SLUG}/signup`);
  await fillIdentity(page, "김구매");
  await page.getByLabel("생년월일").fill("19990231");
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "생년월일 8자리를 다시 확인해 주세요" })).toBeVisible();
  expect(calls).toBe(0);
});

test("인적사항을 서버 형식(birth7·통신사)으로 바꿔 보낸다", async ({ page }) => {
  await mockApi(page);
  await page.goto(`/shop/${SLUG}/signup`);
  await fillIdentity(page, "김구매");
  await page.getByRole("button", { name: "외국인" }).click();
  await page.getByLabel("생년월일").fill("20010305");
  await page.getByLabel("통신사").selectOption({ label: "알뜰폰 (LG U+망)" });
  const req = page.waitForRequest((r) => r.url().endsWith(`${API}/verification`));
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  // 2001년생 외국인 여성 → 8, 화면 폭 1440 → PC
  expect((await req).postDataJSON()).toEqual({ name: "김구매", phone: "01012345678", birth7: "0103058", carrier: "LGU_MVNO", device: "PC" });
});

test("인증번호를 여러 번 틀리면 처음부터 다시 하게 한다", async ({ page }) => {
  await mockApi(page, { confirm: fail(429, "too_many_attempts", IDENTITY_ERROR_MESSAGES.too_many_attempts) });
  await page.goto(`/shop/${SLUG}/signup`);
  await fillIdentity(page, "김구매");
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await page.getByLabel("인증번호").fill("123456");
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: IDENTITY_ERROR_MESSAGES.too_many_attempts })).toBeVisible();
  // 입력한 인적사항은 남기고 다시 받을 수 있는 상태로 돌아간다
  await expect(page.getByLabel("인증번호")).toHaveCount(0);
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue("김구매");
  await expect(page.getByRole("button", { name: "인증번호 받기" })).toBeEnabled();
});

test("다시 받기가 너무 이르면 안내만 하고 인증번호 칸은 그대로 둔다", async ({ page }) => {
  await mockApi(page, { resend: fail(429, "resend_too_soon", IDENTITY_ERROR_MESSAGES.resend_too_soon) });
  await page.goto(`/shop/${SLUG}/signup`);
  await fillIdentity(page, "김구매");
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await page.getByRole("button", { name: "인증번호 다시 받기" }).click();
  await expect(page.getByRole("status").filter({ hasText: IDENTITY_ERROR_MESSAGES.resend_too_soon })).toBeVisible();
  await expect(page.getByLabel("인증번호")).toBeVisible();
});

test("가입 실패는 서버 문구를 해당 칸 아래나 위 안내에 보여 준다", async ({ page }) => {
  const cases: [Reply, "nickname" | "loginId" | "password" | "notice"][] = [
    [fail(409, "nickname_taken", BUYER_SIGNUP_MESSAGES.nickname_taken), "nickname"],
    [fail(409, "login_id_taken", BUYER_SIGNUP_MESSAGES.login_id_taken), "loginId"],
    [fail(400, "weak_password", BUYER_SIGNUP_MESSAGES.weak_password), "password"],
    [fail(409, "already_member", BUYER_SIGNUP_MESSAGES.already_member), "notice"],
  ];
  const field = { nickname: "방송 닉네임", loginId: "아이디 (이메일)", password: "비밀번호" } as const;
  for (const [reply, where] of cases) {
    await page.unrouteAll();
    await mockApi(page, { signup: reply });
    await page.goto(`/shop/${SLUG}/signup`);
    await toVerified(page);
    await fillAccount(page, "x1", "별빛");
    await page.getByRole("button", { name: "가입하기" }).click();
    const message = (reply.body as { message: string }).message;
    if (where === "notice") await expect(page.getByRole("status").filter({ hasText: message })).toBeVisible();
    else {
      await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
      await expect(page.getByLabel(field[where])).toHaveAttribute("aria-invalid", "true");
    }
    // 실패해도 본인확인은 그대로라 고쳐서 다시 가입할 수 있다
    await expect(page.getByText("본인확인을 마쳤어요")).toBeVisible();
    await expect(page.getByRole("button", { name: "가입하기" })).toBeEnabled();
    if (where === "nickname") await shot(page, "SH-011-nickname-taken");
  }
});

test("본인확인이 무효가 되면 처음부터 다시 하게 한다", async ({ page }) => {
  await mockApi(page, { signup: fail(400, "verification_invalid", BUYER_SIGNUP_MESSAGES.verification_invalid) });
  await page.goto(`/shop/${SLUG}/signup`);
  await toVerified(page);
  await fillAccount(page, "x2", "별빛");
  await page.getByRole("button", { name: "가입하기" }).click();
  await expect(page.getByRole("alert").filter({ hasText: BUYER_SIGNUP_MESSAGES.verification_invalid })).toBeVisible();
  await expect(page.getByRole("button", { name: "인증번호 받기" })).toBeVisible();
  await expect(page.getByLabel("아이디 (이메일)")).toBeDisabled();
});

test("중간에 본인확인 서비스가 막히면(503) 준비 중 상태 화면으로 바꾼다", async ({ page }) => {
  await mockApi(page, { verification: fail(503, "identity_unavailable", "본인확인 서비스 준비 중이에요") });
  await page.goto(`/shop/${SLUG}/signup`);
  await fillIdentity(page, "김구매");
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await expect(page.getByRole("heading", { name: "본인확인 서비스 준비 중이에요" })).toBeVisible();
  await expect(page.getByLabel("이름", { exact: true })).toHaveCount(0);
});

// 응답을 붙잡아 두었다가 release()로 돌려준다(요청 중 상태를 확인하려고)
async function hold(page: Page, path: string, reply: Reply) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route((u) => u.pathname === path, async (route) => {
    await gate;
    await route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
  return release;
}

test("인증번호를 요청하는 동안에는 인적사항을 고칠 수 없고, 보낸 값으로 본인확인을 마친다", async ({ page }) => {
  await mockApi(page);
  const release = await hold(page, `${API}/verification`, { status: 200, body: { verificationId: "00000000-0000-4000-8000-000000000000" } });
  await page.goto(`/shop/${SLUG}/signup`);
  await fillIdentity(page, "김구매", "01011112222");
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  // 요청 중: 보낸 값과 화면 값이 달라지지 않게 칸을 잠근다
  await expect(page.getByLabel("이름", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("휴대폰번호", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("생년월일")).toBeDisabled();
  await expect(page.getByLabel("통신사")).toBeDisabled();
  release();
  await page.getByLabel("인증번호").fill("000000");
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.locator("#v-name")).toHaveValue("김구매");
  await expect(page.locator("#v-phone")).toHaveValue("010-1111-2222");
});

test("가입을 요청하는 동안에는 계정 칸을 고칠 수 없고, 완료 문구는 보낸 닉네임을 쓴다", async ({ page }) => {
  await mockApi(page);
  const release = await hold(page, API, { status: 201, body: { ok: true } });
  await page.goto(`/shop/${SLUG}/signup`);
  await toVerified(page);
  await fillAccount(page, "x3", "보낸닉네임");
  await page.getByRole("button", { name: "가입하기" }).click();
  await expect(page.getByLabel("방송 닉네임")).toBeDisabled();
  await expect(page.getByLabel("아이디 (이메일)")).toBeDisabled();
  release();
  await expect(page.getByText("이제 주문할 수 있어요. 방송에서는 보낸닉네임 닉네임으로 보여요.")).toBeVisible();
});

test("방송 닉네임은 서버처럼 글자(코드포인트) 기준으로 20자까지 잘리지 않고 보낸다", async ({ page }) => {
  await mockApi(page);
  await page.goto(`/shop/${SLUG}/signup`);
  await toVerified(page);
  // 이모지 20개 = 서버 기준 20자, UTF-16으로는 40단위
  await fillAccount(page, "x4", "🎮".repeat(20));
  await expect(page.getByText("닉네임은 20자까지 쓸 수 있어요")).toHaveCount(0);
  const req = page.waitForRequest((r) => r.url().endsWith(API) && r.method() === "POST");
  await page.getByRole("button", { name: "가입하기" }).click();
  expect((await req).postDataJSON().broadcastNickname).toBe("🎮".repeat(20));
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
});

test("방송 닉네임이 20자를 넘으면 칸 아래에 알려 주고 가입하기를 막는다", async ({ page }) => {
  await mockApi(page);
  await page.goto(`/shop/${SLUG}/signup`);
  await toVerified(page);
  await fillAccount(page, "x5", "🎮".repeat(21));
  await expect(page.getByText("닉네임은 20자까지 쓸 수 있어요")).toBeVisible();
  await expect(page.getByLabel("방송 닉네임")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "가입하기" })).toBeDisabled();
});

test("확인 응답을 못 받은 뒤 다시 받기에서 이미 확인됐다고 하면 본인확인을 마친 것으로 이어 간다", async ({ page }) => {
  const id = "00000000-0000-4000-8000-000000000000";
  await mockApi(page, { resend: fail(409, "already_verified", IDENTITY_ERROR_MESSAGES.already_verified) });
  // 확인 요청은 서버에서 처리됐지만 응답이 끊긴 상황
  await page.route((u) => u.pathname === `${API}/verification/confirm`, (route) => route.abort());
  await page.goto(`/shop/${SLUG}/signup`);
  await fillIdentity(page, "김구매", "01033334444");
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await page.getByLabel("인증번호").fill("000000");
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "연결이 끊겼어요" })).toBeVisible();
  await page.getByRole("button", { name: "인증번호 다시 받기" }).click();
  // 처음부터 다시 하지 않고(판매자 본인확인 비용을 버리지 않고) 확인 완료로 넘어간다
  await expect(page.getByRole("region", { name: "본인확인" }).locator(".signup-done")).toBeVisible();
  await expect(page.locator("#v-name")).toHaveValue("김구매");
  await expect(page.locator("#v-phone")).toHaveValue("010-3333-4444");
  await fillAccount(page, "x6", "별빛");
  const req = page.waitForRequest((r) => r.url().endsWith(API) && r.method() === "POST");
  await page.getByRole("button", { name: "가입하기" }).click();
  expect((await req).postDataJSON().verificationId).toBe(id);
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
});

// 같은 주소에 차례대로 다른 응답을 준다(마지막 응답은 계속 반복)
async function seq(page: Page, path: string, replies: Reply[]) {
  let i = 0;
  await page.route((u) => u.pathname === path, (route) => {
    const reply = replies[Math.min(i++, replies.length - 1)];
    return route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
}
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");

test("생년월일이 틀리면 포커스를 생년월일 칸으로 옮긴다", async ({ page }) => {
  await mockApi(page);
  await page.goto(`/shop/${SLUG}/signup`);
  await fillIdentity(page, "김구매");
  await page.getByLabel("생년월일").fill("19990231");
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await expect.poll(() => focusedId(page)).toBe("idv-birth");
});

test("요청이 끝나면 포커스가 본문으로 빠지지 않고 다음에 할 곳으로 간다", async ({ page }) => {
  await mockApi(page);
  await seq(page, `${API}/verification/confirm`, [fail(400, "wrong_code", IDENTITY_ERROR_MESSAGES.wrong_code), { status: 200, body: { ok: true } }]);
  await seq(page, API, [fail(409, "nickname_taken", BUYER_SIGNUP_MESSAGES.nickname_taken), { status: 201, body: { ok: true } }]);
  await page.goto(`/shop/${SLUG}/signup`);
  await fillIdentity(page, "김구매");
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  // 인증번호를 받으면 인증번호 칸
  await expect.poll(() => focusedId(page)).toBe("idv-code");
  await page.getByLabel("인증번호").fill("111111");
  await page.getByRole("button", { name: "확인", exact: true }).click();
  // 틀리면 다시 인증번호 칸
  await expect(page.getByRole("alert").filter({ hasText: IDENTITY_ERROR_MESSAGES.wrong_code })).toBeVisible();
  await expect.poll(() => focusedId(page)).toBe("idv-code");
  await page.getByLabel("인증번호").fill("000000");
  await page.getByRole("button", { name: "확인", exact: true }).click();
  // 본인확인을 마치면 아이디 칸
  await expect.poll(() => focusedId(page)).toBe("acc-id");
  await fillAccount(page, "x7", "별빛");
  await page.getByRole("button", { name: "가입하기" }).click();
  // 칸 오류면 그 칸
  await expect.poll(() => focusedId(page)).toBe("acc-nick");
  await page.getByLabel("방송 닉네임").fill("별빛2");
  await page.getByRole("button", { name: "가입하기" }).click();
  // 가입하면 완료 제목
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
  await expect.poll(() => focusedId(page)).toBe("shop-state-title");
});

test("위쪽 안내가 뜨면 안내로, 약관 오류면 약관 체크박스로 포커스를 옮기고 오류를 연결한다", async ({ page }) => {
  await mockApi(page);
  await seq(page, API, [fail(409, "already_member", BUYER_SIGNUP_MESSAGES.already_member), fail(400, "terms_required", BUYER_SIGNUP_MESSAGES.terms_required)]);
  await page.goto(`/shop/${SLUG}/signup`);
  await toVerified(page);
  await fillAccount(page, "x8", "별빛");
  await page.getByRole("button", { name: "가입하기" }).click();
  await expect(page.getByRole("status").filter({ hasText: BUYER_SIGNUP_MESSAGES.already_member })).toBeVisible();
  await expect.poll(() => focusedId(page)).toBe("signup-notice");
  await page.getByRole("button", { name: "가입하기" }).click();
  await expect.poll(() => focusedId(page)).toBe("acc-terms-all");
  for (const label of ["약관에 모두 동의해요", "이용약관 (필수)", "개인정보 수집 · 이용 (필수)"]) {
    const box = page.getByLabel(label, { exact: true });
    await expect(box).toHaveAttribute("aria-invalid", "true");
    await expect(box).toHaveAttribute("aria-describedby", "acc-terms-err");
  }
  await expect(page.locator("#acc-terms-err")).toHaveText(BUYER_SIGNUP_MESSAGES.terms_required);
});

test("체험 한도로 본인확인이 막히면 처음부터 다시 하게 하지 않고 가입할 수 없음 상태를 보여 준다", async ({ page }) => {
  for (const step of ["verification", "confirm"] as const) {
    await page.unrouteAll();
    const blocked = fail(403, "trial_limit_exceeded", IDENTITY_ERROR_MESSAGES.trial_limit_exceeded);
    await mockApi(page, step === "verification" ? { verification: blocked } : { confirm: blocked });
    await page.goto(`/shop/${SLUG}/signup`);
    await fillIdentity(page, "김구매");
    await page.getByRole("button", { name: "인증번호 받기" }).click();
    if (step === "confirm") {
      await page.getByLabel("인증번호").fill("000000");
      await page.getByRole("button", { name: "확인", exact: true }).click();
    }
    await expect(page.getByRole("heading", { name: "지금은 가입할 수 없어요" })).toBeVisible();
    await expect(page.getByRole("button", { name: "인증번호 받기" })).toHaveCount(0);
  }
});

test("가입 응답을 못 받으면 같은 본인확인으로 다시 보내지 않고 로그인으로 가입 여부를 확인한다", async ({ page }) => {
  await mockApi(page);
  let signups = 0;
  await page.route((u) => u.pathname === API, (route) => {
    signups++;
    return route.abort();
  });
  const logins: unknown[] = [];
  let loginOk = false;
  await page.route((u) => u.pathname === `/api/shop/${SLUG}/auth/login`, (route) => {
    logins.push(route.request().postDataJSON());
    return loginOk
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
      : route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "invalid_credentials", message: "x" }) });
  });
  await page.goto(`/shop/${SLUG}/signup`);
  await toVerified(page);
  await fillAccount(page, "x9", "별빛");
  await page.getByRole("button", { name: "가입하기" }).click();
  // 로그인으로 확인했지만 아직 계정이 없으면: 확인하지 못했다고 알리고 가입은 다시 보내지 않는다
  await expect(page.getByText("가입 결과를 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요")).toBeVisible();
  await expect(page.getByRole("button", { name: "가입하기" })).toBeDisabled();
  expect(logins).toEqual([{ loginId: "buyer-x9@example.com", password: "pw-x9-long" }]);
  // 다시 확인: 이번에는 가입돼 있어 로그인 성공 → 완료 화면
  loginOk = true;
  await page.getByRole("button", { name: "가입 결과 다시 확인" }).click();
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
  expect(signups).toBe(1);
  expect(logins).toHaveLength(2);
});

test("마케팅 정보 수신은 선택이고, 체크 여부를 agreedMarketing으로 그대로 보낸다", async ({ page }) => {
  for (const agree of [false, true]) {
    await page.unrouteAll();
    await mockApi(page);
    await page.goto(`/shop/${SLUG}/signup`);
    await toVerified(page);
    await page.getByLabel("아이디 (이메일)").fill("buyer-mk@example.com");
    await page.getByLabel("비밀번호").fill("pw-mk-long");
    await page.getByLabel("방송 닉네임").fill("별빛");
    const marketing = page.getByLabel("(선택) 마케팅 정보 수신");
    // 기본은 해제
    await expect(marketing).not.toBeChecked();
    if (agree) {
      // 전체 동의에 선택 항목도 들어간다
      await page.getByLabel("약관에 모두 동의해요", { exact: true }).check();
      await expect(marketing).toBeChecked();
    } else {
      // 필수만 동의해도 가입할 수 있다
      await page.getByLabel("이용약관 (필수)").check();
      await page.getByLabel("개인정보 수집 · 이용 (필수)").check();
      await expect(page.getByLabel("약관에 모두 동의해요", { exact: true })).not.toBeChecked();
    }
    const req = page.waitForRequest((r) => r.url().endsWith(API) && r.method() === "POST");
    await page.getByRole("button", { name: "가입하기" }).click();
    expect((await req).postDataJSON().agreedMarketing).toBe(agree);
    await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
  }
});
