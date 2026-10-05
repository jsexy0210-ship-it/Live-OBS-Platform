import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { NICKS, cleanupBroadcastQueue, resetBroadcastQueue } from "./seller-broadcast-db";
import { attachLiveAndChat, chatEnabledInDb, resetYoutube, seedYoutube, setChatLinkState } from "./youtubeDb";

// SA-001 방송 대시보드의 유튜브 채팅 수집: 상단 토글(켜기 전 보관 고지 확인, 끌 때는 바로)과 주문대기 「채팅」 열(표시만).
// 연결된 유튜브 방송이 없으면 토글·열이 없고 연결 안내만 보인다. 실제 유튜브는 부르지 않는다(연결·채팅은 DB에 직접 만듦).
// 서버는 YOUTUBE_API_KEY(아무 값)·SCHEDULER_DISABLED=1로 띄운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const [, B] = NICKS;

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  if (!process.env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY가 없어요. 서버와 같은 값(아무 값)을 넣고 SCHEDULER_DISABLED=1로 서버를 띄워 주세요");
});
test.beforeEach(async () => resetBroadcastQueue());
const RUN_STARTED = new Date();
test.afterAll(async () => {
  // 유튜브 연결이 방송을 가리키므로 연결부터 지운 뒤 방송을 정리한다
  await resetYoutube();
  await cleanupBroadcastQueue(RUN_STARTED);
});

async function openAndStart(page: Page) {
  await page.goto("/seller/login?next=%2Fseller%2Fbroadcast");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === "/seller/broadcast");
  await page.getByRole("button", { name: "방송 시작" }).click();
  await expect(page.getByTestId("bc-live-badge")).toBeVisible();
}

test("연결된 유튜브 방송이 없으면 토글과 채팅 열이 없고 연결 안내만 보인다", async ({ page }) => {
  await resetYoutube();
  await openAndStart(page);
  await expect(page.getByTestId("bc-chat-bar")).toContainText("유튜브 방송을 이어 두면 채팅을 가져올 수 있습니다");
  await expect(page.getByTestId("bc-chat-bar").getByRole("link", { name: "유튜브 이어 두기" })).toHaveAttribute("href", "/seller/youtube");
  await expect(page.getByTestId("bc-chat-toggle")).toHaveCount(0);
  await expect(page.getByTestId("bc-chat-head")).toHaveCount(0);
});

test("채팅 수집은 기본 꺼짐: 켜기 전 보관 고지를 확인하고, 켜면 채팅 열이 생기고, 끄면 바로 사라진다", async ({ page }) => {
  await seedYoutube();
  await openAndStart(page);
  const toggle = page.getByTestId("bc-chat-toggle");
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId("bc-chat-head")).toHaveCount(0);

  // 켜기: 보관 고지가 있는 확인 창. 닫으면 켜지지 않는다
  await toggle.click();
  const dlg = page.getByRole("dialog", { name: "유튜브 채팅 가져오기를 켜시겠습니까?" });
  await expect(page.getByTestId("bc-chat-notice")).toContainText("30일 동안 보관합니다");
  await dlg.getByRole("button", { name: "취소" }).click();
  await expect(toggle).not.toBeChecked();
  expect(await chatEnabledInDb()).toBe(false);

  await toggle.click();
  await page.getByRole("dialog", { name: "유튜브 채팅 가져오기를 켜시겠습니까?" }).getByRole("button", { name: "채팅 가져오기 켜기" }).click();
  await expect(toggle).toBeChecked();
  expect(await chatEnabledInDb()).toBe(true);
  await expect(page.getByTestId("bc-chat-head")).toBeVisible();
  // 방송 시간 안에 들어온 주문이 아니면 확인 대상이 아니라 「-」(방송 전 주문을 「채팅 없음」으로 오해하지 않게)
  await expect(page.getByTestId("bc-chat-cell").first()).toHaveText("-");

  // 방송 채팅에 닉네임이 나오면(새로 읽을 때) 그 주문만 「채팅 확인됨」, 나머지는 그대로. 순서·개봉에는 영향이 없다
  await attachLiveAndChat(B, [NICKS[0]]);
  await page.reload();
  const rowB = page.getByTestId("bc-waiting").locator("tr", { hasText: B });
  await expect(rowB.getByTestId("bc-chat-cell")).toContainText("채팅함 · 마지막 채팅 시각");
  await expect(page.getByTestId("bc-waiting").locator("tr", { hasText: NICKS[0] }).getByTestId("bc-chat-cell")).toHaveText("채팅 기록 없음");
  await expect(page.getByTestId("bc-waiting").locator("tr", { hasText: NICKS[2] }).getByTestId("bc-chat-cell")).toHaveText("-");

  // 끄기는 확인 없이 바로, 열도 사라진다
  await page.getByTestId("bc-chat-toggle").click();
  await expect(page.getByTestId("bc-chat-toggle")).not.toBeChecked();
  await expect.poll(() => chatEnabledInDb()).toBe(false);
  await expect(page.getByTestId("bc-chat-head")).toHaveCount(0);
});

test("채팅 수집이 멈추거나 받을 수 없는 방송이면 대시보드 띠로 이유를 알리고, 주문 처리는 그대로다", async ({ page }) => {
  await seedYoutube();
  await setChatLinkState({ status: "LIVE", chatEnabled: true, liveChatId: null, chatStopReason: null }); // 유튜브가 채팅을 주지 않는 방송(no_live_chat)
  await openAndStart(page);
  const band = page.getByTestId("bc-chat-state");
  await expect(band).toContainText("채팅을 받을 수 없음");
  await expect(band).toContainText("이 방송은 채팅을 쓸 수 없습니다");

  // 비공개·회원 전용(chat_forbidden)
  await setChatLinkState({ status: "LIVE", chatEnabled: true, liveChatId: "e2e-chat", chatStopReason: "chat_forbidden" });
  await page.reload();
  await expect(page.getByTestId("bc-chat-state")).toContainText("비공개 또는 회원 전용");

  // 유튜브 일시 오류(paused): 1분 뒤 자동 재시도 안내
  await setChatLinkState({ status: "LIVE", chatEnabled: true, liveChatId: "e2e-chat", chatStopReason: "youtube_error" });
  await page.reload();
  await expect(page.getByTestId("bc-chat-state")).toContainText("채팅 수집 일시 중지");

  // 수집 중이면 띠가 없다. 어느 경우에도 개봉 시작은 막히지 않는다
  await setChatLinkState({ status: "LIVE", chatEnabled: true, liveChatId: "e2e-chat", chatStopReason: null });
  await page.reload();
  await expect(page.getByTestId("bc-chat-bar")).toBeVisible();
  await expect(page.getByTestId("bc-chat-state")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /개봉 시작/ })).toBeEnabled();
});
