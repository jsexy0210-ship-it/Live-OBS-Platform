import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-041 회원 목록·검색, SA-042 회원 상세: 데모 구매자(dev-seed: 별빛사냥꾼·카드왕·민트컨디션)로 실제 API를 눌러 확인한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("대표자: 회원 목록에서 닉네임으로 찾고, 상세에서 주문·누적 결제·적립금을 서버 값 그대로 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fmembers");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/members$/);
  await expect(page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "회원 목록", exact: true })).toHaveAttribute("href", "/seller/members");

  const rows = page.getByTestId("member-row");
  for (const nick of ["별빛사냥꾼", "카드왕", "민트컨디션"]) await expect(rows.filter({ hasText: nick })).toHaveCount(1);
  // 대표자는 개인정보 열람이 되므로 회원 칸에 이름 · 휴대폰이 보이고, 검색 대상(닉네임 · 이름 · 휴대폰 뒷자리)을 고를 수 있다
  await expect(page.getByLabel("검색 대상")).toBeVisible();
  await expect(page.getByLabel("회원 검색")).toHaveAttribute("placeholder", "검색어 입력");
  await expect(rows.filter({ hasText: "카드왕" })).toContainText("데모구매자2");
  const listed: { id: string; orderCount: number; totalPaid: number; rewardBalance: number }[] = await page.evaluate(async () => (await (await fetch("/api/seller/members?limit=10")).json()).members);
  const headers = await page.locator("thead th").allTextContents();
  for (const m of listed) {
    const cells = rows.filter({ has: page.locator(`a[href="/seller/members/${m.id}"]`) }).getByRole("cell");
    for (const [label, value] of [["주문", `${m.orderCount.toLocaleString("ko-KR")}`], ["누적 구매", `${m.totalPaid.toLocaleString("ko-KR")}원`], ["적립금", `${m.rewardBalance.toLocaleString("ko-KR")}원`]]) {
      expect(headers.indexOf(label)).toBeGreaterThanOrEqual(0);
      await expect(cells.nth(headers.indexOf(label))).toHaveText(value);
    }
  }
  await shot(page, "SA-041-members");

  // 검색: 마지막 조건의 응답만 반영된다
  const searched = page.waitForResponse((r) => r.url().includes("/api/seller/members?") && r.url().includes("q=") && r.ok());
  await page.getByLabel("회원 검색").fill("카드왕");
  await page.getByRole("search").getByRole("button", { name: "검색", exact: true }).click();
  await searched;
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("카드왕");

  // 구매 제한 필터: 데모 회원은 구매 제한이 없어 결과가 없고, 초기화로 돌아온다
  await page.getByRole("radio", { name: "구매 제한", exact: true }).check();
  await page.getByRole("search").getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByText("조건에 맞는 회원이 없습니다")).toBeVisible();
  await page.locator(".st").getByRole("button", { name: "초기화", exact: true }).click();
  await expect(rows.filter({ hasText: "민트컨디션" })).toHaveCount(1);

  // 상세: 화면 숫자가 API 응답과 같다
  await rows.filter({ hasText: "별빛사냥꾼" }).getByRole("link", { name: "별빛사냥꾼" }).click();
  await expect(page).toHaveURL(/\/seller\/members\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const api = await page.evaluate(async (id) => (await (await fetch(`/api/seller/members/${id}`)).json()).member, id);
  await expect(page.getByRole("heading", { name: "별빛사냥꾼" })).toBeVisible();
  await expect(page.getByTestId("member-orders")).toHaveText(`${api.orderCount.toLocaleString("ko-KR")}건`);
  await expect(page.getByTestId("member-paid")).toHaveText(`${api.totalPaid.toLocaleString("ko-KR")}원`);
  await expect(page.getByTestId("member-reward")).toHaveText(`${api.rewardBalance.toLocaleString("ko-KR")}원`);
  await expect(page.getByText("데모구매자1")).toBeVisible();
  await shot(page, "SA-042-member-detail");

  // 없는 회원
  await page.goto("/seller/members/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("회원을 찾을 수 없습니다")).toBeVisible();
});

test("회원·적립금 권한이 없는 직원은 메뉴가 안 보이고, 주소로 들어와도 권한 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fmembers");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/members$/);
  await expect(page.getByText("필요한 권한: 회원·적립금", { exact: false })).toBeVisible();
  await expect(page.locator("a[href=\"/seller/members\"]")).toHaveCount(0);
});

test("대표자: 「엑셀 내려받기」는 사유를 고른 뒤에만 열리고, 내려받은 파일에 회원이 담긴다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fmembers");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/members$/);
  await page.getByRole("button", { name: "엑셀 내려받기 (대표자)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "내려받기", exact: true })).toBeDisabled();
  await expect(dialog).toContainText("개인정보가 담긴 파일입니다");
  // 직접 입력은 사유를 적어야 열린다
  await dialog.getByLabel("내보내는 사유").selectOption("직접 입력");
  await expect(dialog.getByRole("button", { name: "내려받기", exact: true })).toBeDisabled();
  await dialog.getByLabel("사유 직접 입력").fill("분기 정산 확인");
  await expect(dialog.getByRole("button", { name: "내려받기", exact: true })).toBeEnabled();
  await dialog.getByLabel("내보내는 사유").selectOption("세무 · 회계 자료");
  await shot(page, "SA-041-export-dialog");
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "내려받기", exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf-8");
  expect(text).toContain("별빛사냥꾼");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// SA-041 정본 v286: 요약 6칸 · 검색 조건 · 정렬 · 선택 열과 선택 작업
async function openMembers(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/seller/login?next=%2Fseller%2Fmembers");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/members$/);
  await expect(page.getByTestId("member-row").first()).toBeVisible();
}

test("요약 6칸은 서버 집계 그대로이고, 검색 조건 · 정렬은 목록 조회 조건으로 나간다", async ({ page }) => {
  await openMembers(page);
  const s: { total: number; newThisMonth: number; purchasedThisMonth: number; gold: number; vip: number; restricted: number; marketingConsent: number } = await page.evaluate(async () => (await (await fetch("/api/seller/members/summary")).json()).summary);
  const sum = page.getByRole("region", { name: "요약", exact: true });
  const n = (v: number) => v.toLocaleString("ko-KR");
  await expect(sum).toContainText(`전체 회원${n(s.total)}명`);
  await expect(sum).toContainText(`이번 달 신규${n(s.newThisMonth)}명`);
  await expect(sum).toContainText(`이번 달 구매 회원${n(s.purchasedThisMonth)}명`);
  await expect(sum).toContainText(`골드 · VIP${n(s.gold)} / ${n(s.vip)}`);
  await expect(sum).toContainText(`구매 제한${n(s.restricted)}명`);
  await expect(sum).toContainText(`혜택 · 소식 동의${n(s.marketingConsent)}명`);
  await shot(page, "SA-041-summary-search");

  // 「검색」을 누르기 전에는 조건이 나가지 않고, 누르면 선택한 조건이 한 번에 나간다
  await page.getByLabel("최근 주문").selectOption("90d");
  await page.getByRole("checkbox", { name: "적립금 잔액 있음" }).check();
  const request = page.waitForRequest((r) => r.url().includes("/api/seller/members?") && r.url().includes("hasBalance=true"));
  await page.getByRole("search").getByRole("button", { name: "검색", exact: true }).click();
  const url = new URL((await request).url());
  expect(url.searchParams.get("lastOrder")).toBe("90d");
  expect(url.searchParams.get("hasBalance")).toBe("true");
  expect(url.searchParams.get("sort")).toBe("lastOrder");
  // 가입일 기본은 최근 1개월(정본 SA-041): 조회에 시작일 · 종료일이 나가고, 「전체」를 고르고 검색하면 주소에 period=all이 남고 가입일 조건이 빠진다
  expect(url.searchParams.get("joinedFrom")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(url.searchParams.get("joinedTo")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await page.getByRole("group", { name: "기간 빠른 선택" }).getByRole("button", { name: "전체", exact: true }).click();
  const all = page.waitForRequest((r) => r.url().includes("/api/seller/members?") && !r.url().includes("joinedFrom"));
  await page.getByRole("search").getByRole("button", { name: "검색", exact: true }).click();
  await all;
  await expect(page).toHaveURL(/period=all/);
  // 정렬은 고르는 즉시 적용된다
  const sorted = page.waitForRequest((r) => r.url().includes("/api/seller/members?") && r.url().includes("sort=spent"));
  await page.getByLabel("정렬").selectOption("spent");
  await sorted;
  await page.getByRole("search").getByRole("button", { name: "초기화", exact: true }).click();
  await expect(page.getByLabel("최근 주문")).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: "적립금 잔액 있음" })).not.toBeChecked();
});

test("선택한 회원: 선택 작업은 선택 전에는 막히고, 선택 알림 발송은 회원 알림 발송의 「직접 선택」으로 넘어간다", async ({ page }) => {
  await openMembers(page);
  const send = page.getByRole("button", { name: "선택 알림 발송", exact: true });
  const adjust = page.getByRole("button", { name: "선택 등급 조정", exact: true });
  await expect(send).toBeDisabled();
  await expect(adjust).toBeDisabled();
  await page.getByRole("checkbox", { name: "별빛사냥꾼 선택" }).check();
  await page.getByRole("checkbox", { name: "카드왕 선택" }).check();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page).toHaveURL(/\/seller\/member-messages\?section=new&picked=1$/);
  await expect(page.getByRole("button", { name: "직접 선택", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/선택 2명:/)).toContainText("별빛사냥꾼");
  await expect(page.getByText(/선택 2명:/)).toContainText("카드왕");
});

test("선택 등급 조정: 등급을 고르면 선택한 회원의 등급이 바뀌고 목록에 반영된다(끝에 원래 등급으로 돌린다)", async ({ page }) => {
  await openMembers(page);
  const row = page.getByTestId("member-row").filter({ hasText: "별빛사냥꾼" });
  const before: { grades: { id: string; displayName: string }[] } = await page.evaluate(async () => (await fetch("/api/seller/member-grades")).json());
  const member: { id: string; grade: { id: string; displayName: string } } = await page.evaluate(async () => (await (await fetch("/api/seller/members?q=%EB%B3%84%EB%B9%9B")).json()).members[0]);
  const target = before.grades.find((g) => g.id !== member.grade.id)!;
  await row.getByRole("checkbox").check();
  await page.getByRole("button", { name: "선택 등급 조정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /선택한 회원 1명의 등급을 조정하시겠습니까/ });
  await expect(dialog.getByRole("button", { name: "등급 조정", exact: true })).toBeDisabled();
  // 고정을 켜기 전에는 종료일 · 사유를 쓸 수 없다
  await expect(dialog.getByLabel("고정 종료일")).toBeDisabled();
  await expect(dialog.getByLabel("사유")).toBeDisabled();
  await dialog.getByLabel("등급", { exact: true }).selectOption(target.id);
  await dialog.getByRole("button", { name: "등급 조정", exact: true }).click();
  await expect(page.getByText("1명의 등급을 조정했습니다")).toBeVisible();
  await expect(row).toContainText(target.displayName);
  // 원래 등급으로 되돌린다
  const restored = await page.evaluate(async ({ id, gradeId }) => (await fetch(`/api/seller/member-grades/members/${id}`, { method: "PUT", headers: { "content-type": "application/json", origin: location.origin }, body: JSON.stringify({ gradeId, lock: false }) })).status, { id: member.id, gradeId: member.grade.id });
  expect(restored).toBe(200);
});

test("회원 · 적립금 쓰기 권한이 없으면 선택 열과 선택 작업 버튼이 보이지 않는다(읽기만)", async ({ page }) => {
  // 화면의 권한 판단만 본다: /me 응답에서 회원 · 적립금 권한을 뺀다(서버 거절은 서버 시험 소관)
  await page.route("**/api/seller/me", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, isOwner: false, permissions: ["CUSTOMER_PII_VIEW"] } });
  });
  await openMembers(page);
  await expect(page.getByRole("button", { name: "선택 알림 발송", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "선택 등급 조정", exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "이 쪽 전체 선택" })).toHaveCount(0);
  await expect(page.getByTestId("member-row").first().getByRole("checkbox")).toHaveCount(0);
});

test("휴대폰 뒷자리는 숫자 4자리일 때만 적용되고, 정렬을 바꿔도 아직 누르지 않은 검색 조건은 남는다", async ({ page }) => {
  await openMembers(page);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/seller/members?")) requests.push(r.url());
  });
  await page.getByLabel("검색 대상").selectOption("phoneLast4");
  await page.getByLabel("회원 검색").fill("12");
  await page.getByRole("search").getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "숫자 4자리" })).toBeVisible();
  expect(requests.filter((u) => u.includes("qType=phoneLast4"))).toHaveLength(0);
  await page.getByLabel("회원 검색").fill("9001");
  const sent = page.waitForRequest((r) => r.url().includes("qType=phoneLast4") && r.url().includes("q=9001"));
  await page.getByRole("search").getByRole("button", { name: "검색", exact: true }).click();
  await sent;
  await expect(page.getByRole("alert").filter({ hasText: "숫자 4자리" })).toHaveCount(0);

  // 아직 「검색」을 누르지 않은 조건은 정렬을 바꿔도 지워지지 않는다
  await page.getByRole("checkbox", { name: "메모 있음" }).check();
  await page.getByLabel("정렬").selectOption("joined");
  await expect(page.getByRole("checkbox", { name: "메모 있음" })).toBeChecked();
  await expect(page.getByLabel("회원 검색")).toHaveValue("9001");
});
