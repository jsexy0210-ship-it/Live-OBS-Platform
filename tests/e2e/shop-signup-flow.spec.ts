import { expect, request, test, type Page } from "@playwright/test";
import { MARKETING_DOC_VERSION } from "../../components/shop/MarketingConsentDoc";
import { SIGNUP_CONSENT_VERSIONS } from "../../lib/server/buyers/consent";
import { BUYER_SIGNUP_MESSAGES } from "../../lib/server/buyers/signup";
import { setMemberPolicyInDb } from "./memberPolicyDb";
import { IDENTITY_ERROR_MESSAGES } from "../../lib/server/identity/messages";
import { okConfirm } from "./shopConfirm";

// SH-011 구매자 회원가입 4단계(약관 /signup → 본인확인 /signup/verify → 정보 입력 /signup/account → 완료 /signup/done) 흐름 — 개발 서버(가짜 본인확인 공급자, 인증번호 000000)에서 돈다(playwright.config.ts 「dev」).
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

// 새 가입 흐름은 단계마다 주소가 따로다(약관 /signup → 본인확인 /signup/verify → 정보 입력 /signup/account → 완료 /signup/done).
// 라벨의 「*」는 라벨 안에 있어 이름 앞부분으로 찾는다.
const F = {
  name: /^이름/,
  birth: /^생년월일/,
  carrier: /^통신사/,
  phone: /^휴대폰번호/,
  code: /^인증번호/,
  id: /^이메일/,
  pw: /^비밀번호$/,
  pw2: /^비밀번호 확인/,
  nick: /^방송 닉네임/,
};
const SEND = "인증번호 문자 받기";
const NEXT = { name: "다음", exact: true } as const;

// 1단계: 필수 약관 셋에 동의하고(선택 마케팅은 marketing으로) 다음으로 간다
async function agreeTerms(page: Page, opts: { marketing?: boolean } = {}) {
  await page.getByLabel("이용약관 동의 (필수)").check();
  await page.getByLabel("개인정보 수집 · 이용 동의 (필수)").check();
  await page.getByLabel("만 14세 이상이에요 (필수)").check();
  if (opts.marketing) await page.getByLabel("방송 · 혜택 알림 받기 (선택)").check();
  await page.getByRole("button", NEXT).click();
  await expect(page).toHaveURL(/\/signup\/verify$/);
}

// 2단계 입력(1단계 동의 포함). 보내기 버튼은 누르지 않는다.
async function fillIdentity(page: Page, name: string, phone = "01012345678", opts: { marketing?: boolean } = {}) {
  await page.goto(`/shop/${SLUG}/signup`);
  await agreeTerms(page, opts);
  await page.getByLabel(F.name).fill(name);
  await page.getByLabel(F.birth).fill("19990101");
  await page.getByRole("button", { name: "여", exact: true }).click();
  await page.getByLabel(F.carrier).selectOption("KT");
  await page.getByLabel(F.phone).fill(phone);
  await page.getByLabel("본인확인 이용 약관에 모두 동의해요").check();
}

async function fillAccount(page: Page, id: string, nickname: string) {
  await page.getByLabel(F.id).fill(`buyer-${id}@example.com`);
  const password = `pw-${id}1-long`;
  await page.getByLabel(F.pw).fill(password);
  await page.getByLabel(F.pw2).fill(password);
  await page.getByLabel(F.nick).fill(nickname);
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


// 3단계(정보 입력)까지: 약관 → 본인확인 → 다음
async function toAccount(page: Page, name = "김구매") {
  await fillIdentity(page, name);
  await page.getByRole("button", { name: SEND }).click();
  await page.getByLabel(F.code).fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  await expect(page.getByText("본인확인 완료").first()).toBeVisible();
  await page.getByRole("button", NEXT).click();
  await expect(page).toHaveURL(/\/signup\/account$/);
}

// 2단계에서 인증번호를 받고 확인까지(본인확인 완료 상태)
async function toVerifiedStep(page: Page, name = "김구매", phone = "01012345678") {
  await fillIdentity(page, name, phone);
  await page.getByRole("button", { name: SEND }).click();
  await page.getByLabel(F.code).fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  await expect(page.locator(".sg-verified")).toBeVisible();
}

const submitSignup = async (page: Page) => {
  await page.getByRole("button", { name: "가입하기", exact: true }).click();
  await okConfirm(page, "가입하기");
};
const DONE = (nick: string) => `방송에서는 ${nick} 닉네임으로 보여요`;
const phoneDash = (p: string) => `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}`;
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");

test("1단계: 필수 약관 셋이 모두 켜져야 다음이 열리고, 모두 동의해요는 선택까지 함께 켜고 끈다. 마케팅은 선택이다", async ({ page }) => {
  await mockApi(page);
  await page.goto(`/shop/${SLUG}/signup`);
  await expect(page.getByRole("heading", { name: "회원가입" })).toBeVisible();
  await expect(page.getByText("1 / 4")).toBeVisible();
  const next = page.getByRole("button", NEXT);
  await expect(next).toBeDisabled();
  await shot(page, "SH-011-1");
  const required = ["이용약관 동의 (필수)", "개인정보 수집 · 이용 동의 (필수)", "만 14세 이상이에요 (필수)"];
  for (const label of required) await page.getByLabel(label).check();
  // 선택은 켜지 않아도 된다
  await expect(next).toBeEnabled();
  await expect(page.getByLabel("방송 · 혜택 알림 받기 (선택)")).not.toBeChecked();
  await expect(page.getByLabel("모두 동의해요")).not.toBeChecked();
  // 하나라도 풀면 다시 막히고 필수 안내가 뜬다
  for (const label of required) {
    await page.getByLabel(label).uncheck();
    await expect(next).toBeDisabled();
    await expect(page.getByRole("alert").filter({ hasText: "필수 약관에 동의해 주세요" })).toBeVisible();
    await page.getByLabel(label).check();
    await expect(next).toBeEnabled();
  }
  await page.getByLabel("모두 동의해요").check();
  await expect(page.getByLabel("방송 · 혜택 알림 받기 (선택)")).toBeChecked();
  await page.getByLabel("모두 동의해요").uncheck();
  for (const label of required) await expect(page.getByLabel(label)).not.toBeChecked();
  // 재가입 제한을 끈 쇼핑몰이라 보관 동의 칸은 없다
  await expect(page.getByText("재가입 제한 정보 보관", { exact: false })).toHaveCount(0);
  // 취소·로그인 링크
  await expect(page.getByRole("link", { name: "취소" })).toHaveAttribute("href", `/shop/${SLUG}`);
  await expect(page.getByRole("link", { name: "로그인" })).toHaveAttribute("href", `/shop/${SLUG}/login`);
});

test("앞 단계 없이 주소로 바로 들어오면 첫 미완료 단계로 보내고, 끝낸 단계의 입력값은 그대로 둔다", async ({ page }) => {
  await mockApi(page);
  for (const path of ["/verify", "/account", "/done"]) {
    await page.goto(`/shop/${SLUG}/signup${path}`);
    await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/signup$`));
    await expect(page.getByText("앞 단계부터 진행해 주세요. 약관 동의로 돌아가요")).toBeVisible();
  }
  await shot(page, "SH-011-guard");
  // 약관만 끝낸 상태에서 정보 입력 주소로 가면 본인확인으로 보낸다
  await page.goto(`/shop/${SLUG}/signup`);
  await agreeTerms(page);
  await page.goto(`/shop/${SLUG}/signup/account`);
  await expect(page).toHaveURL(/\/signup\/verify$/);
  await expect(page.getByText("앞 단계부터 진행해 주세요. 휴대폰 본인확인으로 돌아가요")).toBeVisible();
});

test("새로고침하거나 이전 단계로 돌아가도 입력값이 남고(비밀번호만 빼고), 본인확인 결과도 그대로다", async ({ page }) => {
  await mockApi(page);
  await toAccount(page, "김유지");
  await fillAccount(page, "keep", "유지닉");
  // 이전 단계로: 본인확인 결과 그대로, 입력한 정보는 남고 비밀번호 칸만 비워진다
  await page.getByRole("button", { name: "이전 단계" }).click();
  await expect(page).toHaveURL(/\/signup\/verify$/);
  await expect(page.locator(".sg-verified")).toContainText("김유지");
  await page.getByRole("button", NEXT).click();
  await expect(page.getByLabel(F.id)).toHaveValue("buyer-keep@example.com");
  await expect(page.getByLabel(F.nick)).toHaveValue("유지닉");
  await expect(page.getByLabel(F.pw)).toHaveValue("");
  await expect(page.getByLabel(F.pw2)).toHaveValue("");
  // 새로고침해도 남는다
  await page.reload();
  await expect(page).toHaveURL(/\/signup\/account$/);
  await expect(page.getByLabel(F.id)).toHaveValue("buyer-keep@example.com");
  await expect(page.getByLabel(F.pw)).toHaveValue("");
  await expect(page.locator(".sg-verified")).toContainText("김유지");
  // 약관 단계로 돌아가도 동의가 그대로다
  await page.goto(`/shop/${SLUG}/signup`);
  await expect(page.getByLabel("이용약관 동의 (필수)")).toBeChecked();
  await expect(page.getByRole("button", NEXT)).toBeEnabled();
});

test("버튼이 잠긴 이유를 보여 준다: 인증번호 문자 받기·가입하기에 아직 필요한 항목, 비밀번호 확인이 다르면 알려 준다", async ({ page }) => {
  await mockApi(page, {});
  await page.goto(`/shop/${SLUG}/signup`);
  await agreeTerms(page);
  const send = page.getByRole("button", { name: SEND });
  const missing = page.locator("#idv-missing");
  await expect(send).toBeDisabled();
  await expect(missing).toContainText("이름 · 생년월일 8자리 · 통신사 · 휴대폰번호 · 본인확인 이용 약관 동의");
  await page.getByLabel(F.name).fill("김별빛");
  await expect(missing).not.toContainText("이름");
  await fillIdentity(page, "김별빛");
  await expect(missing).toHaveCount(0);
  await expect(send).toBeEnabled();

  await toAccount(page);
  const join = page.getByRole("button", { name: "가입하기", exact: true });
  await expect(join).toBeDisabled();
  await expect(page.locator("#acc-missing")).toContainText("아이디 · 비밀번호 · 방송 닉네임");
  await page.getByLabel(F.id).fill("a@example.com");
  await page.getByLabel(F.pw).fill("password-1234");
  await page.getByLabel(F.nick).fill("별빛");
  await expect(page.locator("#acc-missing")).toContainText("비밀번호 확인");
  await page.getByLabel(F.pw2).fill("password-12");
  await expect(page.getByText("비밀번호가 서로 달라요")).toBeVisible();
  await expect(join).toBeDisabled();
  await page.getByLabel(F.pw2).fill("password-1234");
  await expect(page.getByText("비밀번호가 서로 달라요")).toHaveCount(0);
  await expect(page.locator("#acc-missing")).toHaveCount(0);
  await expect(join).toBeEnabled();
});

test("본인확인 → 틀린 인증번호 → 맞는 인증번호 → 정보 입력 → 가입 완료까지 실제로 된다", async ({ page }) => {
  const id = uniq();
  const phone = uniqPhone();
  await page.goto(`/shop/${SLUG}/signup`);
  await agreeTerms(page);
  await expect(page.getByText("2 / 4")).toBeVisible();
  await expect(page.getByRole("button", { name: SEND })).toBeDisabled();
  await expect(page.getByRole("button", NEXT)).toBeDisabled();
  await shot(page, "SH-011-2");

  await fillIdentity(page, `구매${id}`, phone);
  const sent = page.waitForResponse((r) => r.url().endsWith(`${API}/verification`));
  await page.getByRole("button", { name: SEND }).click();
  expect((await sent).status()).toBe(200);
  await expect(page.getByText("인증번호를 보냈어요. 문자로 받은 6자리를 넣어 주세요")).toBeVisible();
  // 인증번호를 받은 뒤에는 인적사항을 고칠 수 없다(고치려면 「정보 다시 입력」)
  await expect(page.getByLabel(F.name)).toBeDisabled();
  await shot(page, "SH-011-2-code");

  await page.getByLabel(F.code).fill("111111");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: IDENTITY_ERROR_MESSAGES.wrong_code })).toBeVisible();
  await expect(page.getByLabel(F.code)).toHaveAttribute("aria-invalid", "true");
  await shot(page, "SH-011-2-wrong-code");

  await page.getByLabel(F.code).fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  const card = page.locator(".sg-verified");
  await expect(card).toContainText("본인확인 완료");
  await expect(card).toContainText(`구매${id}`);
  await expect(card).toContainText(phoneDash(phone));
  await expect(card).toContainText("1999년생");
  await expect(card).toContainText("바꿀 수 없어요");
  await shot(page, "SH-011-2-verified");
  // 본인확인을 마치면 다음 버튼으로 포커스
  await expect.poll(() => focusedId(page)).toBe("sg-next");
  await page.getByRole("button", NEXT).click();

  await expect(page).toHaveURL(/\/signup\/account$/);
  await expect(page.getByText("3 / 4")).toBeVisible();
  await fillAccount(page, id, `별${id}`);
  await shot(page, "SH-011-3");
  const done = page.waitForResponse((r) => r.url().endsWith(API) && r.request().method() === "POST");
  await submitSignup(page);
  expect((await done).status()).toBe(201);
  await expect(page).toHaveURL(/\/signup\/done$/);
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
  await expect(page.getByText(DONE(`별${id}`))).toBeVisible();
  await expect(page.getByRole("link", { name: "쇼핑 계속하기" })).toHaveAttribute("href", `/shop/${SLUG}`);
  await shot(page, "SH-011-4");
  // 가입을 마친 뒤 새로고침하면(로그인 상태) 홈으로 간다
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}$`));
});

test("실제 서버: 본인확인 결과를 확인 응답 값으로 보여 주고, 가입 응답만 끊겨도 같은 요청 재전송(201)으로 완료한다", async ({ page }) => {
  const id = uniq();
  const phone = uniqPhone();
  // 가입 요청은 서버가 처리하게 두고 첫 응답만 끊는다(서버에서는 회원이 만들어진 상태)
  const statuses: number[] = [];
  await page.route((u) => u.pathname === API, async (route) => {
    const res = await route.fetch();
    statuses.push(res.status());
    return statuses.length === 1 ? route.abort() : route.fulfill({ response: res });
  });
  // 전각·앞뒤 공백 이름: 공급자 결과(NFKC 정규화·trim)를 보여 줘야 한다
  await fillIdentity(page, ` Ｋｉｍ${id} `, phone);
  await page.getByRole("button", { name: SEND }).click();
  await page.getByLabel(F.code).fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  await expect(page.locator(".sg-verified")).toContainText(`Kim${id}`);
  await expect(page.locator(".sg-verified")).toContainText(phoneDash(phone));
  await page.getByRole("button", NEXT).click();
  await fillAccount(page, id, `ＡＢ${id}`);
  await submitSignup(page);
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
  await expect(page.getByText(DONE(`AB${id}`))).toBeVisible();
  expect(statuses).toEqual([201, 201]);
});

test("생년월일이 없는 날짜면 요청을 보내지 않고 칸 아래에 알려 준다", async ({ page }) => {
  let calls = 0;
  await page.route((u) => u.pathname.startsWith(API), (route) => {
    calls++;
    return route.abort();
  });
  await fillIdentity(page, "김구매");
  await page.getByLabel(F.birth).fill("19990231");
  await page.getByRole("button", { name: SEND }).click();
  await expect(page.getByRole("alert").filter({ hasText: "생년월일 8자리를 다시 확인해 주세요" })).toBeVisible();
  expect(calls).toBe(0);
});

test("인적사항을 서버 형식(birth7·통신사)으로 바꿔 보낸다", async ({ page }) => {
  await mockApi(page);
  await fillIdentity(page, "김구매");
  await page.getByRole("button", { name: "외국인" }).click();
  await page.getByLabel(F.birth).fill("20010305");
  await page.getByLabel(F.carrier).selectOption({ label: "알뜰폰 (LG U+망)" });
  const req = page.waitForRequest((r) => r.url().endsWith(`${API}/verification`));
  await page.getByRole("button", { name: SEND }).click();
  // 2001년생 외국인 여성 → 8, 화면 폭 1440 → PC
  expect((await req).postDataJSON()).toEqual({
    name: "김구매",
    phone: "01012345678",
    birth7: "0103058",
    carrier: "LGU_MVNO",
    device: "PC",
    attemptKey: expect.stringMatching(UUID),
    // 1단계에서 받은 필수 동의와 화면이 보여 준 문서 버전을 본인확인 시작에 함께 보낸다(데모 쇼핑몰은 재가입 제한 꺼짐)
    agreedTerms: true,
    agreedPrivacy: true,
    termsVersion: SIGNUP_CONSENT_VERSIONS.terms,
    privacyVersion: SIGNUP_CONSENT_VERSIONS.privacy,
    // 선택 마케팅 수신 동의도 본인확인 전에 받는다(체크 안 함)
    agreedMarketing: false,
  });
});

// 화면을 연 뒤 동의 문서가 바뀌었다(409 consent_outdated): 이 화면의 글은 예전 것이라 1단계로 돌려보내고 새로고침하게 한다
test("본인확인 시작이 문서 바뀜(consent_outdated)이면 약관 단계로 돌려보내 새로고침을 안내하고 다음을 막는다", async ({ page }) => {
  await mockApi(page, { verification: fail(409, "consent_outdated", BUYER_SIGNUP_MESSAGES.consent_outdated) });
  await fillIdentity(page, "김구매");
  await page.getByRole("button", { name: SEND }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/signup$`));
  await expect(page.getByText("약관이 바뀌었어요. 다시 확인해 주세요")).toBeVisible();
  const box = page.getByTestId("idv-reload-box");
  await expect(box).toContainText("새로고침이 필요해요.");
  await expect.poll(() => focusedId(page)).toBe("idv-reload");
  await expect(page.getByRole("button", NEXT)).toBeDisabled();
  await shot(page, "SH-011-1-reload");
  await page.unrouteAll();
  await box.getByRole("button", { name: "새로고침" }).click();
  await expect(box).toHaveCount(0);
  // 앞 동의는 비워지고 다시 동의해야 한다. 본인확인 입력값은 그대로 남는다
  await expect(page.getByLabel("이용약관 동의 (필수)")).not.toBeChecked();
  await agreeTerms(page);
  await expect(page.getByLabel(F.name)).toHaveValue("김구매");
});

// 선택 마케팅 수신: 동의하기 전에 서식 전체를 볼 수 있고, 동의하면 그 서식에 묶인 버전을 보낸다
test("마케팅 정보 수신 동의는 서식 전체를 보여 주고, 보인 서식의 버전을 보낸다", async ({ page }) => {
  await mockApi(page);
  await page.goto(`/shop/${SLUG}/signup`);
  await page.locator(".sg-chk", { hasText: "방송 · 혜택 알림 받기 (선택)" }).getByRole("button", { name: "보기" }).click();
  const doc = page.getByTestId("mc-doc");
  await expect(doc).toContainText("카드숍 별빛은(는) 라이브 방송 시작·이벤트·할인·새 상품 소식을 보내기 위해");
  await expect(doc.getByRole("cell", { name: "이름, 휴대폰 번호" })).toBeVisible();
  await fillIdentity(page, "김구매", "01012345678", { marketing: true });
  const req = page.waitForRequest((r) => r.url().endsWith(`${API}/verification`));
  await page.getByRole("button", { name: SEND }).click();
  expect((await req).postDataJSON()).toMatchObject({ agreedMarketing: true, marketingVersion: MARKETING_DOC_VERSION });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("본인확인 시작은 같은 인적사항의 재시도에 같은 attemptKey를 쓰고, 보내는 중(409)이면 서버 문구를 보여 준다. 인적사항을 바꾸거나 시작에 성공하면 새 키", async ({ page }) => {
  const keys: string[] = [];
  const replies: Array<"abort" | Reply> = [
    "abort", // 응답이 끊김
    fail(409, "start_in_progress", "인증번호를 보내고 있어요. 잠시 뒤 다시 시도해 주세요"),
    { status: 200, body: { verificationId: "00000000-0000-4000-8000-000000000000" } },
  ];
  await page.route((u) => u.pathname === `${API}/verification`, (route) => {
    keys.push(route.request().postDataJSON().attemptKey);
    const reply = replies.shift() ?? { status: 200, body: { verificationId: "00000000-0000-4000-8000-000000000001" } };
    return reply === "abort" ? route.abort("connectionreset") : route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
  await fillIdentity(page, "김구매");
  const send = page.getByRole("button", { name: SEND });
  await send.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText("인증번호를 보내고 있어요. 잠시 뒤 다시 시도해 주세요")).toBeVisible();
  await send.click();
  await expect(page.getByLabel(F.code)).toBeVisible();
  expect(keys).toHaveLength(3);
  expect(keys[0]).toMatch(UUID);
  expect(new Set(keys).size).toBe(1);
  // 처음부터 다시 하고 같은 값으로 시작해도 앞 시작은 끝났으니 새 키
  await page.getByRole("button", { name: "정보 다시 입력" }).click();
  await send.click();
  await expect.poll(() => keys.length).toBe(4);
  expect(keys[3]).not.toBe(keys[0]);
});

test("본인확인 시작 응답이 끊긴 뒤 휴대폰번호를 바꾸면 새 attemptKey로 보낸다", async ({ page }) => {
  const keys: string[] = [];
  await page.route((u) => u.pathname === `${API}/verification`, (route) => {
    keys.push(route.request().postDataJSON().attemptKey);
    return keys.length === 1
      ? route.abort("connectionreset")
      : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ verificationId: "00000000-0000-4000-8000-000000000000" }) });
  });
  await fillIdentity(page, "김구매");
  const send = page.getByRole("button", { name: SEND });
  await send.click();
  await expect.poll(() => keys.length).toBe(1);
  await page.getByLabel(F.phone).fill("01099998888");
  await send.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toMatch(UUID);
  expect(keys[1]).not.toBe(keys[0]);
});

test("인증번호를 여러 번 틀리면 처음부터 다시 하게 한다", async ({ page }) => {
  await mockApi(page, { confirm: fail(429, "too_many_attempts", IDENTITY_ERROR_MESSAGES.too_many_attempts) });
  await fillIdentity(page, "김구매");
  await page.getByRole("button", { name: SEND }).click();
  await page.getByLabel(F.code).fill("123456");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: IDENTITY_ERROR_MESSAGES.too_many_attempts })).toBeVisible();
  // 입력한 인적사항은 남기고 다시 받을 수 있는 상태로 돌아간다
  await expect(page.getByLabel(F.code)).toHaveCount(0);
  await expect(page.getByLabel(F.name)).toHaveValue("김구매");
  await expect(page.getByRole("button", { name: SEND })).toBeEnabled();
});

test("다시 받기가 너무 이르면 안내만 하고 인증번호 칸은 그대로 둔다", async ({ page }) => {
  await mockApi(page, { resend: fail(429, "resend_too_soon", IDENTITY_ERROR_MESSAGES.resend_too_soon) });
  await fillIdentity(page, "김구매");
  await page.getByRole("button", { name: SEND }).click();
  await page.getByRole("button", { name: "다시 받기", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: IDENTITY_ERROR_MESSAGES.resend_too_soon })).toBeVisible();
  await expect(page.getByLabel(F.code)).toBeVisible();
});

test("가입 실패는 서버 문구를 해당 칸 아래나 위 안내에 보여 준다", async ({ page }) => {
  const cases: [Reply, "nickname" | "loginId" | "password" | "notice"][] = [
    [fail(409, "nickname_taken", BUYER_SIGNUP_MESSAGES.nickname_taken), "nickname"],
    [fail(409, "login_id_taken", BUYER_SIGNUP_MESSAGES.login_id_taken), "loginId"],
    [fail(400, "weak_password", BUYER_SIGNUP_MESSAGES.weak_password), "password"],
    [fail(409, "already_member", BUYER_SIGNUP_MESSAGES.already_member), "notice"],
  ];
  const field = { nickname: F.nick, loginId: F.id, password: F.pw } as const;
  for (const [reply, where] of cases) {
    await page.unrouteAll();
    await mockApi(page, { signup: reply });
    await toAccount(page);
    await fillAccount(page, "x1", "별빛");
    await submitSignup(page);
    const message = (reply.body as { message: string }).message;
    if (where === "notice") await expect(page.getByRole("status").filter({ hasText: message })).toBeVisible();
    else {
      await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
      await expect(page.getByLabel(field[where])).toHaveAttribute("aria-invalid", "true");
    }
    // 실패해도 본인확인은 그대로라 고쳐서 다시 가입할 수 있다
    await expect(page.getByText("본인확인 완료")).toBeVisible();
    await expect(page.getByRole("button", { name: "가입하기", exact: true })).toBeEnabled();
    if (where === "nickname") await shot(page, "SH-011-3-nickname-taken");
  }
});

test("본인확인이 무효가 되면 처음부터 다시 하게 한다", async ({ page }) => {
  await mockApi(page, { signup: fail(400, "verification_invalid", BUYER_SIGNUP_MESSAGES.verification_invalid) });
  await toAccount(page);
  await fillAccount(page, "x2", "별빛");
  await submitSignup(page);
  await expect(page).toHaveURL(/\/signup\/verify$/);
  await expect(page.getByRole("alert").filter({ hasText: BUYER_SIGNUP_MESSAGES.verification_invalid })).toBeVisible();
  await expect(page.getByRole("button", { name: SEND })).toBeVisible();
  await expect(page.getByRole("button", NEXT)).toBeDisabled();
});

test("중간에 본인확인 서비스가 막히면(503) 이 단계에서 준비 중 안내를 보이고 입력칸과 버튼을 잠근다", async ({ page }) => {
  await mockApi(page, { verification: fail(503, "identity_unavailable", "본인확인 서비스 준비 중이에요") });
  await fillIdentity(page, "김구매");
  await page.getByRole("button", { name: SEND }).click();
  await expect(page.getByText("지금은 가입할 수 없어요. 휴대폰 본인확인 서비스를 준비하고 있어요")).toBeVisible();
  await expect(page.getByLabel(F.name)).toBeDisabled();
  await expect(page.getByRole("button", { name: SEND })).toBeDisabled();
  await shot(page, "SH-011-2-unavailable");
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

test("인증번호를 요청하는 동안에는 본인확인 동의 체크도 바꿀 수 없다(보낸 동의와 화면이 어긋나지 않게)", async ({ page }) => {
  await mockApi(page);
  const release = await hold(page, `${API}/verification`, { status: 200, body: { verificationId: "00000000-0000-4000-8000-000000000000" } });
  await fillIdentity(page, "김구매", "01011112222", { marketing: true });
  const req = page.waitForRequest((r) => r.url().endsWith(`${API}/verification`) && r.method() === "POST");
  await page.getByRole("button", { name: SEND }).click();
  expect((await req).postDataJSON().agreedMarketing).toBe(true);
  await expect(page.getByLabel("본인확인 이용 약관에 모두 동의해요")).toBeDisabled();
  await expect(page.getByLabel("본인확인 이용 약관에 모두 동의해요")).toBeChecked();
  release();
  await expect(page.getByLabel(F.code)).toBeVisible();
});

test("인증번호를 요청하는 동안에는 인적사항을 고칠 수 없고, 보낸 값으로 본인확인을 마친다", async ({ page }) => {
  await mockApi(page);
  const release = await hold(page, `${API}/verification`, { status: 200, body: { verificationId: "00000000-0000-4000-8000-000000000000" } });
  await fillIdentity(page, "김구매", "01011112222");
  await page.getByRole("button", { name: SEND }).click();
  // 요청 중: 보낸 값과 화면 값이 달라지지 않게 칸을 잠근다
  await expect(page.getByLabel(F.name)).toBeDisabled();
  await expect(page.getByLabel(F.phone)).toBeDisabled();
  await expect(page.getByLabel(F.birth)).toBeDisabled();
  await expect(page.getByLabel(F.carrier)).toBeDisabled();
  release();
  await page.getByLabel(F.code).fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  await expect(page.locator(".sg-verified")).toContainText("김구매");
  await expect(page.locator(".sg-verified")).toContainText("010-1111-2222");
});

test("가입을 요청하는 동안에는 계정 칸을 고칠 수 없고, 완료 문구는 보낸 닉네임을 쓴다", async ({ page }) => {
  await mockApi(page);
  const release = await hold(page, API, { status: 201, body: { ok: true } });
  await toAccount(page);
  await fillAccount(page, "x3", "보낸닉네임");
  await submitSignup(page);
  await expect(page.getByLabel(F.nick)).toBeDisabled();
  await expect(page.getByLabel(F.id)).toBeDisabled();
  release();
  await expect(page.getByText(DONE("보낸닉네임"))).toBeVisible();
});

test("방송 닉네임은 서버처럼 글자(코드포인트) 기준으로 20자까지 잘리지 않고 보낸다", async ({ page }) => {
  await mockApi(page);
  await toAccount(page);
  // 이모지 20개 = 서버 기준 20자, UTF-16으로는 40단위
  await fillAccount(page, "x4", "🎮".repeat(20));
  await expect(page.getByText("닉네임은 20자까지 쓸 수 있어요")).toHaveCount(0);
  const req = page.waitForRequest((r) => r.url().endsWith(API) && r.method() === "POST");
  await submitSignup(page);
  expect((await req).postDataJSON().broadcastNickname).toBe("🎮".repeat(20));
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
});

test("방송 닉네임이 20자를 넘으면 칸 아래에 알려 주고 가입하기를 막는다", async ({ page }) => {
  await mockApi(page);
  await toAccount(page);
  await fillAccount(page, "x5", "🎮".repeat(21));
  await expect(page.getByText("닉네임은 20자까지 쓸 수 있어요")).toBeVisible();
  await expect(page.getByLabel(F.nick)).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "가입하기", exact: true })).toBeDisabled();
});

test("확인 응답을 못 받은 뒤 다시 받기에서 이미 확인됐다고 하면 본인확인을 마친 것으로 이어 간다", async ({ page }) => {
  const id = "00000000-0000-4000-8000-000000000000";
  await mockApi(page, { resend: fail(409, "already_verified", IDENTITY_ERROR_MESSAGES.already_verified) });
  // 확인 요청은 서버에서 처리됐지만 첫 응답이 끊긴 상황. 이후 확인 요청은 저장된 결과를 돌려준다.
  let confirms = 0;
  await page.route((u) => u.pathname === `${API}/verification/confirm`, (route) =>
    ++confirms === 1
      ? route.abort()
      : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, identity: { name: "김구매", phone: "01033334444", birthDate: "1999-01-01" } }) }),
  );
  await fillIdentity(page, "김구매", "01033334444");
  await page.getByRole("button", { name: SEND }).click();
  await page.getByLabel(F.code).fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "연결이 끊겼어요" })).toBeVisible();
  await page.getByRole("button", { name: "다시 받기", exact: true }).click();
  // 처음부터 다시 하지 않고(판매자 본인확인 비용을 버리지 않고) 확인 완료로 넘어간다
  await expect(page.locator(".sg-verified")).toContainText("김구매");
  await expect(page.locator(".sg-verified")).toContainText("010-3333-4444");
  await page.getByRole("button", NEXT).click();
  await fillAccount(page, "x6", "별빛");
  const req = page.waitForRequest((r) => r.url().endsWith(API) && r.method() === "POST");
  await submitSignup(page);
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

test("생년월일이 틀리면 포커스를 생년월일 칸으로 옮긴다", async ({ page }) => {
  await mockApi(page);
  await fillIdentity(page, "김구매");
  await page.getByLabel(F.birth).fill("19990231");
  await page.getByRole("button", { name: SEND }).click();
  await expect.poll(() => focusedId(page)).toBe("idv-birth");
});

test("요청이 끝나면 포커스가 본문으로 빠지지 않고 다음에 할 곳으로 간다", async ({ page }) => {
  await mockApi(page);
  await seq(page, `${API}/verification/confirm`, [fail(400, "wrong_code", IDENTITY_ERROR_MESSAGES.wrong_code), { status: 200, body: { ok: true } }]);
  await seq(page, API, [fail(409, "nickname_taken", BUYER_SIGNUP_MESSAGES.nickname_taken), { status: 201, body: { ok: true } }]);
  await fillIdentity(page, "김구매");
  await page.getByRole("button", { name: SEND }).click();
  // 인증번호를 받으면 인증번호 칸
  await expect.poll(() => focusedId(page)).toBe("idv-code");
  await page.getByLabel(F.code).fill("111111");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  // 틀리면 다시 인증번호 칸
  await expect(page.getByRole("alert").filter({ hasText: IDENTITY_ERROR_MESSAGES.wrong_code })).toBeVisible();
  await expect.poll(() => focusedId(page)).toBe("idv-code");
  await page.getByLabel(F.code).fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  // 본인확인을 마치면 다음 버튼, 3단계가 열리면 아이디 칸
  await expect.poll(() => focusedId(page)).toBe("sg-next");
  await page.getByRole("button", NEXT).click();
  await expect.poll(() => focusedId(page)).toBe("acc-id");
  await fillAccount(page, "x7", "별빛");
  await submitSignup(page);
  // 칸 오류면 그 칸
  await expect.poll(() => focusedId(page)).toBe("acc-nick");
  await page.getByLabel(F.nick).fill("별빛2");
  await submitSignup(page);
  // 가입하면 완료 제목
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
  await expect.poll(() => focusedId(page)).toBe("shop-state-title");
});

test("위쪽 안내가 뜨면 안내로 포커스를 옮긴다", async ({ page }) => {
  await mockApi(page);
  await seq(page, API, [fail(409, "already_member", BUYER_SIGNUP_MESSAGES.already_member)]);
  await toAccount(page);
  await fillAccount(page, "x8", "별빛");
  await submitSignup(page);
  await expect(page.getByRole("status").filter({ hasText: BUYER_SIGNUP_MESSAGES.already_member })).toBeVisible();
  await expect.poll(() => focusedId(page)).toBe("signup-notice");
});

test("본인확인 시작이 만 14세 미만(403)이면 안내하고 포커스를 안내로 옮긴다", async ({ page }) => {
  await mockApi(page, { verification: fail(403, "under_age", BUYER_SIGNUP_MESSAGES.under_age) });
  await fillIdentity(page, "김어린");
  await page.getByRole("button", { name: SEND }).click();
  await expect(page.getByRole("alert").filter({ hasText: "만 14세 미만은 가입할 수 없어요. 본인확인 생년월일 기준이에요" })).toBeVisible();
  await expect.poll(() => focusedId(page)).toBe("signup-notice");
  await shot(page, "SH-011-2-under-age");
});

test("본인확인 시작이 동의 오류(약관 없음)면 약관 단계로 돌려보내고 오류를 알린다", async ({ page }) => {
  await mockApi(page, { verification: fail(400, "terms_required", BUYER_SIGNUP_MESSAGES.terms_required) });
  await fillIdentity(page, "김구매");
  await page.getByRole("button", { name: SEND }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/signup$`));
  await expect(page.getByRole("alert").filter({ hasText: BUYER_SIGNUP_MESSAGES.terms_required })).toBeVisible();
});

test("체험 한도로 본인확인이 막히면 처음부터 다시 하게 하지 않고 가입할 수 없음 상태를 보여 준다", async ({ page }) => {
  for (const step of ["verification", "confirm"] as const) {
    await page.unrouteAll();
    const blocked = fail(403, "trial_limit_exceeded", IDENTITY_ERROR_MESSAGES.trial_limit_exceeded);
    await mockApi(page, step === "verification" ? { verification: blocked } : { confirm: blocked });
    await fillIdentity(page, "김구매");
    await page.getByRole("button", { name: SEND }).click();
    if (step === "confirm") {
      await page.getByLabel(F.code).fill("000000");
      await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
    }
    await expect(page.getByRole("heading", { name: "지금은 가입할 수 없어요" })).toBeVisible();
    await expect(page.getByRole("button", { name: SEND })).toHaveCount(0);
    await expect.poll(() => focusedId(page)).toBe("shop-state-title");
  }
});

test("가입 응답이 끊기면 같은 요청을 한 번 다시 보내고, 201이면 서버가 준 닉네임으로 완료한다", async ({ page }) => {
  await mockApi(page);
  const bodies: unknown[] = [];
  await page.route((u) => u.pathname === API, (route) => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1
      ? route.abort()
      : route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, broadcastNickname: "별빛" }) });
  });
  let logins = 0;
  await page.route((u) => u.pathname === `/api/shop/${SLUG}/auth/login`, (route) => {
    logins++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await toAccount(page);
  await fillAccount(page, "x9", "별빛");
  await submitSignup(page);
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
  // 같은 요청을 그대로 한 번 더 보냈고, 로그인으로 확인하지 않는다
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(logins).toBe(0);
});

test("재전송이 또 끊기거나 5xx면 완료로 가지 않고 같은 요청으로 다시 시도하게 한다", async ({ page }) => {
  await mockApi(page);
  const bodies: unknown[] = [];
  await page.route((u) => u.pathname === API, (route) => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1 ? route.abort() : route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  // 예전 계정이 같은 비밀번호로 로그인되는 상황이어도 이번 가입 완료로 보지 않는다
  let logins = 0;
  await page.route((u) => u.pathname === `/api/shop/${SLUG}/auth/login`, (route) => {
    logins++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await toAccount(page);
  await fillAccount(page, "xb", "별빛");
  await submitSignup(page);
  await expect(page.getByText("가입이 끝났는지 확인하지 못했어요. 다시 시도해 주세요")).toBeVisible();
  await expect(page.getByRole("button", { name: "가입하기", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]).toEqual(bodies[0]);
  await expect(page.getByText("가입이 끝났는지 확인하지 못했어요. 다시 시도해 주세요")).toBeVisible();
  await expect(page.getByRole("heading", { name: "가입했어요" })).toHaveCount(0);
  expect(logins).toBe(0);
});

test("재전송이 보통의 가입 오류(409 아이디 중복)면 칸 오류로 보여 주고 고쳐서 다시 가입할 수 있다", async ({ page }) => {
  await mockApi(page);
  const bodies: { loginId: string }[] = [];
  await page.route((u) => u.pathname === API, (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) return route.abort();
    if (bodies.length === 2) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "login_id_taken", message: BUYER_SIGNUP_MESSAGES.login_id_taken }) });
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, broadcastNickname: "별빛" }) });
  });
  await toAccount(page);
  await fillAccount(page, "xd", "별빛");
  await submitSignup(page);
  await expect(page.getByRole("alert").filter({ hasText: BUYER_SIGNUP_MESSAGES.login_id_taken })).toBeVisible();
  await expect(page.getByText("가입이 끝났는지 확인하지 못했어요")).toHaveCount(0);
  const id = page.getByLabel(F.id);
  await expect(id).toBeEnabled();
  await expect.poll(() => focusedId(page)).toBe("acc-id");
  await id.fill("buyer-xd2@example.com");
  await submitSignup(page);
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
  expect(bodies[2].loginId).toBe("buyer-xd2@example.com");
});

test("재전송이 본인확인 무효(400)면 처음부터 다시 하게 한다", async ({ page }) => {
  await mockApi(page);
  let signups = 0;
  await page.route((u) => u.pathname === API, (route) => {
    signups++;
    return signups === 1 ? route.abort() : route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "verification_invalid", message: BUYER_SIGNUP_MESSAGES.verification_invalid }) });
  });
  await toAccount(page);
  await fillAccount(page, "xe", "별빛");
  await submitSignup(page);
  await expect(page.getByRole("alert").filter({ hasText: BUYER_SIGNUP_MESSAGES.verification_invalid })).toBeVisible();
  await expect(page).toHaveURL(/\/signup\/verify$/);
  await expect(page.getByRole("button", { name: SEND })).toBeVisible();
  await expect(page.getByRole("heading", { name: "가입했어요" })).toHaveCount(0);
  expect(signups).toBe(2);
});

test("본인확인 결과 영역은 확인 응답이 준 이름·휴대폰을 보여 준다", async ({ page }) => {
  await mockApi(page, { confirm: { status: 200, body: { ok: true, identity: { name: "홍길동", phone: "01099998888", birthDate: "1999-01-01" } } } });
  await fillIdentity(page, "김구매", "01011112222");
  await page.getByRole("button", { name: SEND }).click();
  await page.getByLabel(F.code).fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  await expect(page.locator(".sg-verified")).toContainText("홍길동");
  await expect(page.locator(".sg-verified")).toContainText("010-9999-8888");
  await page.getByRole("button", NEXT).click();
  await expect(page.locator(".sg-verified")).toContainText("홍길동");
});

test("완료 문구의 닉네임은 가입 응답의 broadcastNickname을 쓴다", async ({ page }) => {
  await mockApi(page, { signup: { status: 201, body: { ok: true, broadcastNickname: "서버닉네임" } } });
  await toAccount(page);
  await fillAccount(page, "xc", "입력닉네임");
  await submitSignup(page);
  await expect(page.getByText(DONE("서버닉네임"))).toBeVisible();
});

test("마케팅 정보 수신은 선택이고 본인확인 전에 받는다: 체크 여부를 본인확인 시작 요청의 agreedMarketing으로, 동의하면 문서 버전도 보낸다", async ({ page }) => {
  for (const agree of [false, true]) {
    await page.unrouteAll();
    await mockApi(page);
    await page.goto(`/shop/${SLUG}/signup`);
    // 기본은 해제이고 필수 세 가지만 체크해도 같이 체크되지 않는다
    await page.getByLabel("방송 · 혜택 알림 받기 (선택)").uncheck();
    await expect(page.getByLabel("방송 · 혜택 알림 받기 (선택)")).not.toBeChecked();
    await fillIdentity(page, "김구매", "01012345678", { marketing: agree });
    const startReq = page.waitForRequest((r) => r.url().endsWith(`${API}/verification`) && r.method() === "POST");
    await page.getByRole("button", { name: SEND }).click();
    const startBody = (await startReq).postDataJSON();
    expect(startBody.agreedMarketing).toBe(agree);
    expect(startBody.marketingVersion).toBe(agree ? SIGNUP_CONSENT_VERSIONS.marketing : undefined);
    await page.getByLabel(F.code).fill("000000");
    await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
    await expect(page.locator(".sg-verified")).toBeVisible();
    await page.getByRole("button", NEXT).click();
    // 정보 입력 단계에는 마케팅 체크가 없고, 가입 본문에도 동의 값을 보내지 않는다
    await expect(page.getByLabel("방송 · 혜택 알림 받기 (선택)")).toHaveCount(0);
    await fillAccount(page, "mk", "별빛");
    const req = page.waitForRequest((r) => r.url().endsWith(API) && r.method() === "POST");
    await submitSignup(page);
    expect((await req).postDataJSON().agreedMarketing).toBeUndefined();
    await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
    // 다음 반복을 위해 가입 기록(세션 저장소)을 비운다
    await page.evaluate(() => sessionStorage.clear());
  }
});

test("완료 문구의 닉네임은 서버가 저장하는 형태(NFKC 정규화)로 보여 준다", async ({ page }) => {
  await mockApi(page);
  await toAccount(page);
  await fillAccount(page, "xa", "ＡＢ①");
  await submitSignup(page);
  await expect(page.getByText(DONE("AB1"))).toBeVisible();
});

test("첫 가입 응답이 5xx면 결과가 애매하다고 보고 같은 요청을 한 번 다시 보내 201이면 완료한다", async ({ page }) => {
  await mockApi(page);
  const bodies: unknown[] = [];
  await page.route((u) => u.pathname === API, (route) => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1
      ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
      : route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, broadcastNickname: "별빛" }) });
  });
  await toAccount(page);
  await fillAccount(page, "xf", "별빛");
  await submitSignup(page);
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
});

test("가입 결과가 애매한 동안에는 이전 단계(본인확인 다시 하기)를 막고 같은 요청으로만 다시 시도하게 한다", async ({ page }) => {
  await mockApi(page);
  let signups = 0;
  await page.route((u) => u.pathname === API, (route) => {
    signups++;
    return signups <= 2 ? route.abort() : route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, broadcastNickname: "별빛" }) });
  });
  await toAccount(page);
  await fillAccount(page, "xg", "별빛");
  await submitSignup(page);
  await expect(page.getByText("가입이 끝났는지 확인하지 못했어요. 다시 시도해 주세요")).toBeVisible();
  // 누르면 본인확인 요청이 사라져 같은 요청으로 복구할 수 없게 된다
  await expect(page.getByRole("button", { name: "이전 단계" })).toBeDisabled();
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
  expect(signups).toBe(3);
});

test("390px: 본인확인 완료 줄은 글자와 버튼이 겹치지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto(`/shop/${SLUG}/signup`);
  await agreeTerms(page);
  // 통신사 첫 항목 글자가 잘리지 않는다
  const carrier = page.getByLabel(F.carrier);
  await expect(carrier).toHaveValue("");
  expect(await carrier.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await toVerifiedStep(page, "가나다라마바사아자차");
  const text = page.locator(".sg-verified-text");
  const button = page.getByRole("button", { name: "다시 하기", exact: true });
  const t = (await text.boundingBox())!;
  const b = (await button.boundingBox())!;
  // 겹치지 않는다(좁은 폭에서는 버튼이 글자 아래 줄로 내려간다)
  const overlap = t.x < b.x + b.width && b.x < t.x + t.width && t.y < b.y + b.height && b.y < t.y + t.height;
  expect(overlap).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, "SH-011-2-390");
});

test("다시 받기가 이미 확인됨이면 확인 결과를 다시 불러와 서버가 확인한 이름을 보여 주고, 못 불러오면 다음 단계로 넘어가지 않는다", async ({ page }) => {
  await mockApi(page, { resend: fail(409, "already_verified", IDENTITY_ERROR_MESSAGES.already_verified) });
  const confirmBodies: unknown[] = [];
  await page.route((u) => u.pathname === `${API}/verification/confirm`, (route) => {
    confirmBodies.push(route.request().postDataJSON());
    // 1: 처음 확인 응답 끊김 2: 결과 다시 불러오기도 끊김 3: 저장된 결과
    if (confirmBodies.length <= 2) return route.abort();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, identity: { name: "Kim정규", phone: "01055556666", birthDate: "1999-01-01" } }) });
  });
  await fillIdentity(page, " Ｋｉｍ정규 ", "01055556666");
  await page.getByRole("button", { name: SEND }).click();
  await page.getByLabel(F.code).fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "연결이 끊겼어요" })).toBeVisible();
  await page.getByRole("button", { name: "다시 받기", exact: true }).click();
  // 결과를 못 불러오면 입력값을 확정 결과처럼 보이지 않고, 다음 단계로 넘어가지 않는다
  await expect(page.getByText("본인확인 결과를 불러오지 못했어요. 다시 시도해 주세요")).toBeVisible();
  await expect(page.locator(".sg-verified")).toHaveCount(0);
  await expect(page.getByRole("button", NEXT)).toBeDisabled();
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(page.locator(".sg-verified")).toContainText("Kim정규");
  await expect(page.locator(".sg-verified")).toContainText("010-5555-6666");
  await expect.poll(() => focusedId(page)).toBe("sg-next");
  expect(confirmBodies).toHaveLength(3);
  expect((confirmBodies[2] as { verificationId: string }).verificationId).toBe("00000000-0000-4000-8000-000000000000");
});

// 재가입 제한(SH-011·SA-043). 재가입 제한은 지금 API로 켤 수 없어 테스트 DB에 직접 넣는다(memberPolicyDb.ts).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
async function setRejoin(_baseURL: string, enabled: boolean, days = 90) {
  await setMemberPolicyInDb(SLUG, enabled, days);
}

test("재가입 제한을 끈 쇼핑몰은 보관 동의 줄이 없다", async ({ page }) => {
  await mockApi(page);
  await toAccount(page);
  await page.getByRole("button", { name: "이전 단계" }).click();
  await expect(page.getByText("재가입 제한 정보 보관", { exact: false })).toHaveCount(0);
});

test("재가입 제한을 켠 쇼핑몰의 보관 동의는 선택(본인확인 전): 체크하지 않아도 인증번호를 받고 가입되며, 체크하면 보여 준 기간·문서 버전을 함께 보낸다. 「보기」에 실제 기간을 보여 준다", async ({ page, baseURL }) => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await setRejoin(baseURL!, true, 90);
  try {
    for (const agree of [false, true]) {
      const id = uniq();
      await page.goto(`/shop/${SLUG}/signup`);
      await page.evaluate(() => sessionStorage.clear());
      await fillIdentity(page, `제한${id}`, uniqPhone());
      const send = page.getByRole("button", { name: SEND });
      const rejoinBox = page.getByLabel("재가입 제한 정보 보관 (선택)");
      // 필수 약관에 들어가지 않고 기본은 체크 안 함, 체크하지 않아도 인증번호를 받을 수 있다
      await expect(rejoinBox).not.toBeChecked();
      await expect(send).toBeEnabled();
      await page.locator("details.signup-terms-doc summary").first().click();
      await expect(page.getByText("보관 기간: 탈퇴한 날부터 90일")).toBeVisible();
      await expect(page.getByText("동의하지 않아도 가입할 수 있어요. 동의하지 않으면 이 정보를 보관하지 않고, 탈퇴한 뒤 다시 가입할 때 기간 제한을 받지 않아요.")).toBeVisible();
      if (agree) await rejoinBox.check();
      const req = page.waitForRequest((r) => r.url().endsWith(`${API}/verification`));
      await send.click();
      const body = (await req).postDataJSON();
      if (agree) expect(body).toMatchObject({ agreedRejoinRetention: true, rejoinRetentionVersion: SIGNUP_CONSENT_VERSIONS.rejoinRetention, rejoinRestrictionDaysShown: 90 });
      else {
        expect(body.agreedRejoinRetention).toBe(false);
        expect(body).not.toHaveProperty("rejoinRestrictionDaysShown");
      }
      await page.getByLabel(F.code).fill("000000");
      await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
      await expect(page.locator(".sg-verified")).toBeVisible();
      await page.getByRole("button", NEXT).click();
      await fillAccount(page, id, `제한${id}`);
      await submitSignup(page);
      await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
    }
  } finally {
    await setRejoin(baseURL!, false);
  }
});

test("재가입 제한 중이면 문구 뒤에 다시 가입할 수 있는 날(KST)을 붙여 보여 준다", async ({ page }) => {
  // 2026-11-02T15:30Z = KST 11월 3일 0시 30분
  await mockApi(page, { signup: { status: 403, body: { error: "rejoin_restricted", message: "지금은 다시 가입할 수 없어요", rejoinAvailableAt: "2026-11-02T15:30:00.000Z" } } });
  await toAccount(page);
  await fillAccount(page, "rj", "제한");
  await submitSignup(page);
  await expect(page.getByText("지금은 다시 가입할 수 없어요. 2026.11.03부터 다시 가입할 수 있어요")).toBeVisible();
});

// 문서 버전이 바뀐 경우(consent_outdated)는 화면의 글이 예전 것이라 새로고침하게 한다(위 「문서 바뀜」 테스트)
test("본인확인 시작 때 재가입 제한 기간이 바뀌었으면 입력은 두고 약관 단계로 돌려보내 동의 정보를 새로 받아 다시 동의하게 한다", async ({ page }) => {
  await mockApi(page, { verification: fail(409, "rejoin_policy_changed", BUYER_SIGNUP_MESSAGES.rejoin_policy_changed) });
  await fillIdentity(page, "김바뀜");
  // 화면 새로 받기(router.refresh)는 같은 틀 주소로 RSC 요청을 보낸다
  const refresh = page.waitForRequest((r) => new URL(r.url()).pathname.startsWith(`/shop/${SLUG}/signup`) && r.headers()["rsc"] === "1");
  await page.getByRole("button", { name: SEND }).click();
  await refresh;
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/signup$`));
  await expect(page.getByRole("alert").filter({ hasText: BUYER_SIGNUP_MESSAGES.rejoin_policy_changed })).toBeVisible();
  await agreeTerms(page);
  await expect(page.getByLabel(F.name)).toHaveValue("김바뀜");
});

test("로그인한 구매자가 가입 주소로 들어오면 홈으로 보낸다", async ({ page, baseURL }) => {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: PASSWORD }, headers: { origin: baseURL! } });
  expect(r.status()).toBe(200);
  for (const path of ["", "/verify", "/account"]) {
    await page.goto(`/shop/${SLUG}/signup${path}`);
    await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}$`));
  }
});

test("들어오기 전 화면(next)이 있으면 가입을 마치고 그 화면으로 돌아간다", async ({ page }) => {
  await mockApi(page);
  await page.goto(`/shop/${SLUG}/signup?next=${encodeURIComponent(`/shop/${SLUG}/cart`)}`);
  await agreeTerms(page);
  await page.getByLabel(F.name).fill("김돌아감");
  await page.getByLabel(F.birth).fill("19990101");
  await page.getByRole("button", { name: "여", exact: true }).click();
  await page.getByLabel(F.carrier).selectOption("KT");
  await page.getByLabel(F.phone).fill("01012345678");
  await page.getByLabel("본인확인 이용 약관에 모두 동의해요").check();
  await page.getByRole("button", { name: SEND }).click();
  await page.getByLabel(F.code).fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기", exact: true }).click();
  await page.getByRole("button", NEXT).click();
  await fillAccount(page, "nx", "돌아감");
  await submitSignup(page);
  await expect(page.getByRole("link", { name: "쇼핑 계속하기" })).toHaveAttribute("href", `/shop/${SLUG}/cart`);
  // 같은 쇼핑몰 밖 주소는 쓰지 않는다
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`/shop/${SLUG}/signup?next=${encodeURIComponent("https://evil.example.com/x")}`);
  await expect(page.getByLabel("이용약관 동의 (필수)")).not.toBeChecked();
});
