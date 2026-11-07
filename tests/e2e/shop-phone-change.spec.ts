import { expect, test, type Page } from "@playwright/test";

// 보드 SH-024-IA 「번호 바꾸기 (본인확인)」 창 4단계 + 오류 상태. 본인확인 공급자(대행사)가 없어 휴대폰 번호 변경 API는 응답을 대신 준다(서버 계약 #1327).
const SLUG = "demo-shop";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = "tests/e2e/screenshots";
const API = `**/api/shop/${SLUG}/me/phone`;

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function open(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
  await page.goto(`/shop/${SLUG}/me/profile`);
  await page.getByRole("button", { name: "번호 바꾸기 (본인확인)" }).click();
  return page.getByRole("dialog", { name: "번호 바꾸기 (본인확인)" });
}
async function fill(dlg: ReturnType<Page["getByRole"]>) {
  await dlg.getByLabel(/^이름/).fill("김별빛");
  await dlg.getByLabel(/^생년월일/).fill("19950505");
  await dlg.getByRole("button", { name: "여" }).click();
  await dlg.getByLabel(/^통신사/).selectOption("SKT");
  await dlg.getByLabel(/^새 휴대폰번호/).fill("01055556666");
  await dlg.getByLabel("본인확인 이용 약관에 모두 동의해요").check();
}
const json = (status: number, body: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

test("창 4단계: 입력 → 인증번호 → 본인확인 완료 → 이 번호로 바꾸기 → 행에 새 번호", async ({ page, baseURL }) => {
  const calls: string[] = [];
  await page.route(`${API}/verification`, (r) => (calls.push("start:" + r.request().postData()), r.fulfill(json(200, { verificationId: "v1" }))));
  await page.route(`${API}/verification/confirm`, (r) => (calls.push("confirm"), r.fulfill(json(200, { identity: { name: "김별빛", phone: "01055556666" } }))));
  await page.route(API, (r) => (calls.push("apply:" + r.request().postData()), r.fulfill(json(200, { ok: true }))));
  const dlg = await open(page, baseURL!);
  await expect(dlg.getByRole("button", { name: "인증번호 문자 받기" })).toBeDisabled();
  await fill(dlg);
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: `${SHOTS}/SH-024-phone-1-${page.viewportSize()!.width}.png` });
  await dlg.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await expect(dlg.getByText("인증번호를 보냈어요. 문자로 받은 6자리를 넣어 주세요")).toBeVisible();
  await dlg.getByLabel(/^인증번호/).fill("123456");
  await dlg.getByRole("button", { name: "인증번호 확인하기" }).click();
  await expect(dlg.getByText("본인확인 완료")).toBeVisible();
  await expect(dlg.getByText("김별빛 · 010-5555-6666 · 1995년생")).toBeVisible();
  expect(calls.some((c) => c.startsWith("apply"))).toBe(false); // 확인만으로는 아직 바뀌지 않는다
  await dlg.getByRole("button", { name: "이 번호로 바꾸기" }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByText("번호를 바꿨어요")).toBeVisible();
  const start = JSON.parse(calls[0].slice(6));
  expect(start).toMatchObject({ name: "김별빛", phone: "01055556666", birth7: "9505052", carrier: "SKT" });
  expect(calls.find((c) => c.startsWith("apply"))).toBe('apply:{"verificationId":"v1"}');
});

test("오류: 같은 번호는 번호 칸에, 하루 한도·충전 꺼짐은 창 안에서 안내하고 보내기를 잠근다", async ({ page, baseURL }) => {
  let n = 0;
  await page.route(`${API}/verification`, (r) => {
    n += 1;
    return r.fulfill(n === 1 ? json(409, { error: "same_phone", message: "지금 쓰는 번호와 다른 번호를 입력해 주세요" }) : n === 2 ? json(429, { error: "daily_limit_exceeded", message: "오늘은 번호 변경 인증을 더 할 수 없어요. 내일 다시 해 주세요" }) : json(503, { error: "phone_change_unavailable", message: "지금은 번호를 바꿀 수 없어요. 쇼핑몰에 문의해 주세요" }));
  });
  const dlg = await open(page, baseURL!);
  await fill(dlg);
  await dlg.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await expect(dlg.getByText("지금 쓰는 번호와 다른 번호를 입력해 주세요")).toBeVisible();
  await dlg.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await expect(dlg.getByText("오늘은 번호 변경 인증을 더 할 수 없어요. 내일 다시 해 주세요")).toBeVisible();
  await expect(dlg.getByRole("button", { name: "인증번호 문자 받기" })).toBeDisabled();
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: `${SHOTS}/SH-024-phone-limit-${page.viewportSize()!.width}.png` });
});

test("오류: 다른 사람 명의 번호는 안내 뒤 「처음부터 다시」로 1단계로 돌아간다", async ({ page, baseURL }) => {
  await page.route(`${API}/verification`, (r) => r.fulfill(json(200, { verificationId: "v2" })));
  await page.route(`${API}/verification/confirm`, (r) => r.fulfill(json(200, { identity: { name: "김별빛", phone: "01055556666" } })));
  await page.route(API, (r) => r.fulfill(json(403, { error: "identity_mismatch", message: "가입할 때 본인확인한 분 명의의 번호로만 바꿀 수 있어요" })));
  const dlg = await open(page, baseURL!);
  await fill(dlg);
  await dlg.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await dlg.getByLabel(/^인증번호/).fill("123456");
  await dlg.getByRole("button", { name: "인증번호 확인하기" }).click();
  await dlg.getByRole("button", { name: "이 번호로 바꾸기" }).click();
  await expect(dlg.getByText("가입할 때 본인확인한 분 명의의 번호로만 바꿀 수 있어요")).toBeVisible();
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: `${SHOTS}/SH-024-phone-mismatch-${page.viewportSize()!.width}.png` });
  await dlg.getByRole("button", { name: "처음부터 다시" }).click();
  await expect(dlg.getByLabel(/^이름/)).toBeVisible();
});

test("본인확인 서비스 준비 중(503 identity_unavailable): 안내 뒤 행의 버튼이 잠기고 「곧 열려요」가 보인다", async ({ page, baseURL }) => {
  await page.route(`${API}/verification`, (r) => r.fulfill(json(503, { error: "identity_unavailable", message: "본인확인 서비스 준비 중이에요" })));
  const dlg = await open(page, baseURL!);
  await fill(dlg);
  await dlg.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await expect(dlg.getByText("본인확인 서비스 준비 중이에요")).toBeVisible();
  await dlg.getByRole("button", { name: "취소" }).click();
  await expect(page.getByRole("button", { name: "번호 바꾸기 (본인확인)" })).toBeDisabled();
  await expect(page.getByText("번호 바꾸기는 곧 열려요")).toBeVisible();
});

test("「바꾸기」 응답을 못 받아도(끊김) 저장된 번호를 다시 읽어 바뀌었으면 완료로 처리한다", async ({ page, baseURL }) => {
  await page.route(`${API}/verification`, (r) => r.fulfill(json(200, { verificationId: "v3" })));
  await page.route(`${API}/verification/confirm`, (r) => r.fulfill(json(200, { identity: { name: "김별빛", phone: "01055556666" } })));
  let applied = false;
  await page.route(API, (r) => ((applied = true), r.abort("failed")));
  await page.route(`**/api/shop/${SLUG}/me/profile`, async (r) => {
    const res = await r.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await r.fulfill({ response: res, json: applied ? { ...body, phoneMasked: "010-****-6666" } : body });
  });
  const dlg = await open(page, baseURL!);
  await fill(dlg);
  await dlg.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await dlg.getByLabel(/^인증번호/).fill("123456");
  await dlg.getByRole("button", { name: "인증번호 확인하기" }).click();
  await dlg.getByRole("button", { name: "이 번호로 바꾸기" }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByText("번호를 바꿨어요")).toBeVisible();
  await page.waitForLoadState("networkidle"); // 완료 뒤 프로필 다시 읽기가 끝나기 전에 시험이 닫히지 않게
});
