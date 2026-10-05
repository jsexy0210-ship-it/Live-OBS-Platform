import { expect, test } from "@playwright/test";
import { clearMessagesInDb, setConsentInDb } from "./messageDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-049 회원 알림 발송(파트너스, 발송 기록만): 정보성 즉시 기록 → 목록·상세, 광고성 시간 밖 예약 거절 → 다음 08:00으로 바꿔 예약 → 취소.
// 운영 빌드 + 데모 시드(demo-owner, 비밀번호 E2E_PASSWORD). 시작·끝에 데모 쇼핑몰의 발송 기록을 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const SHOT = "tests/e2e/screenshots";

let consentBefore = false;
test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await clearMessagesInDb(SLUG);
  consentBefore = await setConsentInDb(SLUG, "demo-buyer1@example.com", true); // 광고성 대상이 있어야 한다
});
test.afterAll(async () => {
  await clearMessagesInDb(SLUG);
  await setConsentInDb(SLUG, "demo-buyer1@example.com", consentBefore);
});

test("대표자: 정보성 발송 기록 → 상세, 광고성 시간 밖 예약은 거절되고 바꿔서 예약 → 취소", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/member-messages")}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/member-messages$/);
  await expect(page.getByRole("link", { name: "회원 알림 발송" })).toHaveClass(/on/);
  await expect(page.getByTestId("mm-summary")).toContainText("혜택 · 소식 동의");
  await expect(page.getByText("실제 발송 채널(알림톡 · 문자 · 메일)이 아직 연결되지 않아 발송 기록만 남습니다")).toBeVisible();
  await expect(page.getByText("발송 내역이 없습니다")).toBeVisible();

  // 정보성: 전체 회원에게 지금 기록
  await page.getByRole("tab", { name: "새 발송" }).click();
  const form = page.getByTestId("mm-new");
  await form.getByLabel("제목").fill("추석 배송 안내");
  await form.getByRole("radio", { name: /정보성/ }).check();
  await form.getByLabel("문구").fill("연휴에는 배송이 하루 늦어져요");
  await expect(page.getByTestId("mm-preview")).toContainText(`[`);
  await expect(page.getByTestId("mm-preview")).toContainText("연휴에는 배송이 하루 늦어져요");
  await expect(page.getByTestId("mm-target-count")).toContainText("대상");
  await page.screenshot({ path: `${SHOT}/sa049-new-1440.png`, fullPage: true });
  await form.getByRole("button", { name: "보내기 (기록)" }).click();
  await page.getByRole("dialog", { name: "발송을 기록하시겠습니까?" }).getByRole("button", { name: "기록" }).click();
  await expect(page.getByText(/명 발송을 기록했습니다 · 실제 발송 전/)).toBeVisible();
  const item = page.getByTestId("mm-item").filter({ hasText: "추석 배송 안내" });
  await expect(item).toContainText("기록됨");
  await item.getByRole("button", { name: "보기" }).click();
  const detail = page.getByRole("dialog", { name: "추석 배송 안내" });
  await expect(detail.getByTestId("mm-body")).toContainText("연휴에는 배송이 하루 늦어져요");
  await expect(detail).toContainText("실제 발송 전");
  await page.screenshot({ path: `${SHOT}/sa049-detail-1440.png` });
  await detail.getByRole("button", { name: "닫기", exact: true }).first().click();

  // 광고성: 내일 22:30(KST) 예약은 거절되고 안내된 시각으로 바꾸면 예약된다
  await page.getByRole("tab", { name: "새 발송" }).click();
  const f2 = page.getByTestId("mm-new");
  await f2.getByLabel("제목").fill("브레이크 예고");
  await f2.getByRole("radio", { name: "광고성" }).check();
  await f2.getByLabel("문구").fill("이번 주말에 새 박스가 들어와요");
  await f2.getByRole("radio", { name: "예약" }).check();
  const tomorrow = new Date(Date.now() + 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
  await f2.getByLabel("예약 시각 (KST)").fill(`${tomorrow}T22:30`);
  await expect(page.locator(".msg-neg")).toContainText("광고성 알림은 08:00 ~ 21:00에만 보낼 수 있습니다");
  await page.screenshot({ path: `${SHOT}/sa049-adwindow-1440.png`, fullPage: true });
  await page.getByRole("button", { name: /으로 바꾸기$/ }).click();
  await expect(f2.getByTestId("mm-preview")).toContainText("예약");
  const send = f2.getByRole("button", { name: "예약하기" });
  await expect(send).toBeEnabled();
  await send.click();
  await page.getByRole("dialog", { name: "예약하시겠습니까?" }).getByRole("button", { name: "예약" }).click();
  await expect(page.getByText("예약했습니다")).toBeVisible();
  const sched = page.getByTestId("mm-item").filter({ hasText: "브레이크 예고" });
  await expect(sched).toContainText("예약");
  await sched.getByRole("button", { name: "취소" }).click();
  await expect(page.getByText("예약을 취소했습니다")).toBeVisible();
  await expect(page.getByTestId("mm-item").filter({ hasText: "브레이크 예고" })).toContainText("취소");
});

test("직원: 회원 · 적립금 권한이 없으면 메뉴가 보이지 않는다", async ({ page }) => {
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/member-messages")}`);
  await submitSellerLogin(page, "demo-none@example.com", PASSWORD);
  await expect(page.getByRole("link", { name: "회원 알림 발송" })).toHaveCount(0);
});
