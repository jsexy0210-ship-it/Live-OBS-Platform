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
  await page.getByLabel("필수 약관에 모두 동의해요").check();
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
  await expect(page.getByText(`첫 주문부터 적립돼요. 방송에서는 별${id} 닉네임으로 보여요.`)).toBeVisible();
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
