import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { E2E_PREFIX, adminReplyInDb, cleanupPlatformE2eInDb, createNoticeInDb, fillInquiryLimitInDb } from "./platformDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-111·112 공지사항, SA-113·114·115 내 문의. 공지는 DB로 만들고, 문의는 파트너스 화면으로 보낸 뒤 마스터 답변·종료를 DB로 흉내 낸다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const TINY = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await cleanupPlatformE2eInDb();
});
test.afterAll(async () => {
  await cleanupPlatformE2eInDb();
});

async function login(page: Page, next: string, email = "demo-owner@example.com") {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await page.waitForURL((u) => u.pathname === next.split("?")[0]);
}

test("공지: 고정 공지가 위에 보이고, 눌러 본문을 읽으며, 없는 공지는 안내한다", async ({ page }) => {
  await createNoticeInDb("일반 안내", { category: "FEATURE" });
  const pinned = await createNoticeInDb("점검 안내", { pinned: true, category: "MAINTENANCE", body: "새벽 2시 점검\n약 30분" });
  await createNoticeInDb("공개 전용", { audience: "PUBLIC" });
  await login(page, "/seller/notices");
  const rows = page.getByTestId("notice-row");
  await expect(rows.first()).toContainText(`${E2E_PREFIX}점검 안내`);
  await expect(rows.first()).toContainText("맨 위 고정");
  await expect(page.getByText(`${E2E_PREFIX}일반 안내`)).toBeVisible();
  await expect(page.getByText(`${E2E_PREFIX}공개 전용`)).toHaveCount(0);
  await rows.first().getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/seller/notices/${pinned}$`));
  await expect(page.getByTestId("notice-title")).toHaveText(`${E2E_PREFIX}점검 안내`);
  await expect(page.getByTestId("notice-body")).toContainText("새벽 2시 점검");
  await expect(page.getByText(/ONQ 운영팀 · \d{4}\.\d{2}\.\d{2} \d{2}:\d{2} 올림/)).toBeVisible();
  await page.goto("/seller/notices/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("공지를 찾을 수 없습니다")).toBeVisible();
});

test("공지 목록: 분류·안 읽은 것만·검색으로 걸러 보고, 열면 읽음이 되며, 20개씩 이전·다음으로 넘긴다", async ({ page }) => {
  await createNoticeInDb("기능 공지", { category: "FEATURE" });
  await createNoticeInDb("점검 공지", { category: "MAINTENANCE" });
  const policy = await createNoticeInDb("정책 공지", { category: "POLICY" });
  await login(page, "/seller/notices");
  const row = (t: string) => page.getByTestId("notice-row").filter({ hasText: `${E2E_PREFIX}${t}` });
  await expect(row("정책 공지")).toContainText("안 읽음");

  // 분류 칸
  await page.getByRole("button", { name: "기능", exact: true }).click();
  await expect(page).toHaveURL(/category=FEATURE/);
  await expect(row("기능 공지")).toBeVisible();
  await expect(row("점검 공지")).toHaveCount(0);
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await expect(page).not.toHaveURL(/category=/);

  // 검색: 결과 없음은 안내와 「검색 초기화」
  await page.getByLabel("공지 검색").fill("없는검색어zz");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByText("「없는검색어zz」 검색 결과가 없습니다")).toBeVisible();
  await page.getByRole("button", { name: "검색 초기화" }).click();
  await expect(row("정책 공지")).toBeVisible();

  // 열면 읽음: 안 읽은 것만 목록에서 빠진다
  await row("정책 공지").getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/seller/notices/${policy}$`));
  await expect(page.getByTestId("notice-title")).toBeVisible();
  await page.goto("/seller/notices?unread=1");
  await expect(page.getByLabel("안 읽은 것만")).toBeChecked();
  await expect(row("정책 공지")).toHaveCount(0);
  await expect(row("기능 공지")).toBeVisible();
  await page.goto("/seller/notices");
  await expect(row("정책 공지")).toContainText("읽음");
});

test("공지 목록: 20개를 넘으면 다음 쪽으로 넘기고, 이전으로 돌아온다", async ({ page }) => {
  for (let i = 0; i < 22; i++) await createNoticeInDb(`쪽 공지 ${String(i).padStart(2, "0")}`);
  await login(page, "/seller/notices");
  await expect(page.getByText(/20개씩 · 1–\d+ 표시/)).toBeVisible();
  await expect(page.getByRole("button", { name: "‹ 이전" })).toBeDisabled();
  await page.getByRole("button", { name: "다음 ›" }).click();
  await expect(page.getByText(/20개씩 · 21–\d+ 표시/)).toBeVisible();
  await page.getByRole("button", { name: "‹ 이전" }).click();
  await expect(page.getByText(/20개씩 · 1–\d+ 표시/)).toBeVisible();
});

test("문의: 공지에서 관련 문의를 보내고, 사진을 붙이고, 답변을 확인한 뒤 추가 문의를 보내며, 종료되면 입력란이 사라진다", async ({ page }) => {
  const noticeId = await createNoticeInDb("문의 연결 공지");
  await login(page, `/seller/notices/${noticeId}`);
  await page.getByRole("link", { name: "이 공지에 대해 문의" }).click();
  await expect(page).toHaveURL(/\/seller\/inquiries\/new\?noticeId=/);
  await expect(page.getByText(`관련 공지: ${E2E_PREFIX}문의 연결 공지`)).toBeVisible();

  const send = page.getByRole("button", { name: "문의 보내기" });
  await expect(send).toBeDisabled();
  await page.getByLabel("유형").selectOption("SUBSCRIPTION_FEE");
  await page.getByLabel("제목").fill(`${E2E_PREFIX}결제 문의`);
  await page.getByLabel("내용").fill("결제 내역이 맞지 않습니다.");
  // 너무 작은 사진은 이유를 알려 주고 붙이지 않는다
  await page.getByLabel("사진 파일").setInputFiles({ name: "tiny.png", mimeType: "image/png", buffer: TINY });
  await expect(page.getByRole("alert").filter({ hasText: "사진 크기가 맞지 않습니다" })).toBeVisible();
  await expect(page.getByAltText("첨부 사진")).toHaveCount(0);
  const png = await sharp({ create: { width: 120, height: 120, channels: 4, background: "#ff3b30" } }).png().toBuffer();
  await page.getByLabel("사진 파일").setInputFiles({ name: "a.png", mimeType: "image/png", buffer: png });
  await expect(page.getByAltText("첨부 사진")).toHaveCount(1);
  await expect(send).toBeEnabled();
  await send.click();
  const sendDialog = page.getByRole("dialog", { name: "문의를 보내시겠습니까?" });
  await expect(sendDialog).toContainText("보낸 뒤에는 수정하거나 지울 수 없습니다");
  await sendDialog.getByRole("button", { name: "문의 보내기" }).click();

  await expect(page).toHaveURL(/\/seller\/inquiries\/[0-9a-f-]{36}$/);
  const id = page.url().split("/").pop()!;
  await expect(page.getByTestId("inquiry-title")).toHaveText(`${E2E_PREFIX}결제 문의`);
  await expect(page.getByText("답변 대기")).toBeVisible();
  await expect(page.getByRole("link", { name: `${E2E_PREFIX}문의 연결 공지` })).toBeVisible();
  await expect(page.getByTestId("inquiry-message")).toHaveCount(1);
  await expect(page.getByTestId("inquiry-message").first().getByAltText("첨부 사진")).toHaveCount(1);

  // 목록: 내 문의 탭에 대기 상태로 보인다
  await page.goto("/seller/inquiries");
  await expect(page.getByTestId("inquiry-row").filter({ hasText: `${E2E_PREFIX}결제 문의` })).toContainText("답변 대기");

  // 마스터 답변 → 새 답변 표시, 상세에는 관리자 이름 없이 「플랫폼」
  await adminReplyInDb(id, "확인 후 안내드립니다.");
  await page.reload();
  const row = page.getByTestId("inquiry-row").filter({ hasText: `${E2E_PREFIX}결제 문의` });
  await expect(row).toContainText("답변 완료");
  await expect(row).toContainText("새 답변");
  await row.getByRole("link").click();
  const reply = page.getByTestId("inquiry-message").nth(1);
  await expect(reply).toContainText("플랫폼");
  await expect(reply).toContainText("확인 후 안내드립니다.");
  // 열었으니 읽음: 목록의 새 답변 표시가 사라진다
  await page.goto("/seller/inquiries");
  await expect(page.getByTestId("inquiry-row").filter({ hasText: `${E2E_PREFIX}결제 문의` })).not.toContainText("새 답변");

  // 추가 문의 → 다시 답변 대기
  await page.goto(`/seller/inquiries/${id}`);
  await page.getByLabel("추가 문의").fill("추가로 여쭙습니다.");
  await page.getByRole("button", { name: "추가 문의 보내기" }).click();
  await page.getByRole("dialog", { name: "추가 문의를 보내시겠습니까?" }).getByRole("button", { name: "추가 문의 보내기" }).click();
  await expect(page.getByTestId("inquiry-message")).toHaveCount(3);
  await expect(page.getByText("답변 대기")).toBeVisible();

  // 종료 → 입력란이 숨고 새 문의 안내
  await adminReplyInDb(id, "문의를 종료합니다.", true);
  await page.reload();
  await expect(page.getByText("종료된 문의입니다")).toBeVisible();
  await expect(page.getByLabel("추가 문의")).toHaveCount(0);
});

test("문의: 유형 없이는 보낼 수 없고, 없는 문의는 안내한다", async ({ page }) => {
  await login(page, "/seller/inquiries/new");
  await page.getByLabel("제목").fill(`${E2E_PREFIX}유형 없음`);
  await page.getByLabel("내용").fill("내용");
  await expect(page.getByRole("button", { name: "문의 보내기" })).toBeDisabled();
  await page.goto("/seller/inquiries/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("문의를 찾을 수 없습니다")).toBeVisible();
});

// #427 검수 후속: 직원은 자기가 쓴 문의만 보고(대표자는 쇼핑몰 전체), 하루 20건을 넘으면 서버 안내문을 그대로 보인다.
async function postInquiry(page: Page, title: string) {
  return page.evaluate(async (t) => {
    const r = await fetch("/api/seller/platform-inquiries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "OTHER", title: t, body: "내용" }) });
    return r.status;
  }, title);
}

test("직원은 자기가 쓴 문의만 보고, 대표자는 쇼핑몰 문의를 모두 본다", async ({ page, browser }) => {
  await login(page, "/seller/inquiries", "demo-viewer@example.com");
  expect(await postInquiry(page, `${E2E_PREFIX}직원 문의`)).toBe(201);
  const other = await browser.newContext();
  const ownerPage = await other.newPage();
  await login(ownerPage, "/seller/inquiries");
  expect(await postInquiry(ownerPage, `${E2E_PREFIX}대표자 문의`)).toBe(201);
  await ownerPage.reload();
  await expect(ownerPage.getByTestId("inquiry-row").filter({ hasText: `${E2E_PREFIX}대표자 문의` })).toHaveCount(1);
  await expect(ownerPage.getByTestId("inquiry-row").filter({ hasText: `${E2E_PREFIX}직원 문의` })).toHaveCount(1);
  await other.close();
  await page.reload();
  await expect(page.getByTestId("inquiry-row").filter({ hasText: `${E2E_PREFIX}직원 문의` })).toHaveCount(1);
  await expect(page.getByTestId("inquiry-row").filter({ hasText: `${E2E_PREFIX}대표자 문의` })).toHaveCount(0);
});

test("하루 20건을 넘기면 보내지 못하고 서버 안내문이 보인다", async ({ page }) => {
  await cleanupPlatformE2eInDb();
  await fillInquiryLimitInDb(20);
  await login(page, "/seller/inquiries/new");
  await page.getByLabel("유형").selectOption("OTHER");
  await page.getByLabel("제목").fill(`${E2E_PREFIX}한도 초과`);
  await page.getByLabel("내용").fill("내용");
  await page.getByRole("button", { name: "문의 보내기" }).click();
  const limitDialog = page.getByRole("dialog", { name: "문의를 보내시겠습니까?" });
  await limitDialog.getByRole("button", { name: "문의 보내기" }).click();
  // 서버가 거절하면 확인 창 안에 안내문을 보이고 닫지 않는다
  await expect(limitDialog.getByRole("alert").filter({ hasText: "하루 20건까지" })).toBeVisible();
  await limitDialog.getByRole("button", { name: "취소" }).click();
  await expect(page).toHaveURL(/\/seller\/inquiries\/new$/);
  await expect(page.getByLabel("제목")).toHaveValue(`${E2E_PREFIX}한도 초과`);
});
