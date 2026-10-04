import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-051 오버레이 편집기: 위젯 위치·크기·속성을 고쳐 저장하면 실제 API에 남고, 오버레이 화면(OV-001)이 그 배치대로 그려진다.
// 다른 창에서 먼저 저장했으면 409 안내, 템플릿 초기화·내 템플릿 저장·삭제까지. 모두 실제 API를 부른다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const NAME = `e2e-tpl-${Date.now().toString(36)}`;

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function login(page: Page) {
  await page.goto("/seller/login?next=/seller/overlay");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === "/seller/overlay");
  await expect(page.getByTestId("ove-canvas")).toBeVisible();
}

async function call<T>(page: Page, path: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const r = await fetch(path, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    },
    { path, method, body },
  );
}
type L = { version: number; widgets: { id: string; type: string; x: number; y: number; w: number; h: number; visible: boolean; props: Record<string, unknown> }[] };
const layout = async (page: Page, aspect = "9x16") => (await call<L>(page, `/api/seller/overlay/layout?aspect=${aspect}`)).data;
// 시작 상태: 기본 템플릿으로
async function reset(page: Page, aspect = "9x16") {
  const l = await layout(page, aspect);
  const r = await call(page, "/api/seller/overlay/layout/reset", "POST", { aspect, template: "queue_focus", expectedVersion: l.version });
  expect(r.status).toBe(200);
}
const toast = (page: Page) => page.getByRole("status").filter({ has: page.locator(".toast") });

test("위치·크기·속성을 고쳐 저장하면 서버에 남고, 오버레이 화면이 그 배치로 바뀐다", async ({ page, context }) => {
  test.setTimeout(90_000);
  await login(page);
  await reset(page);
  await page.reload();
  await expect(page.getByTestId("ove-canvas")).toBeVisible();

  // 선택 → 위치 입력
  await page.getByRole("button", { name: "현재 주문", exact: true }).click();
  await expect(page.getByTestId("ove-dirty")).toHaveCount(0);
  await page.getByLabel("세로 위치").fill("40");
  await page.getByLabel("제목 색", { exact: true }).fill("#112233");
  await expect(page.getByTestId("ove-dirty")).toHaveText("저장 안 한 변경 1개");

  // 끌어서 옮기기(주문대기 위젯)
  const box = page.getByTestId("ove-box-queue");
  const before = await box.boundingBox();
  await box.hover();
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2 + 20, before!.y + before!.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  const after = await box.boundingBox();
  expect(after!.y).toBeGreaterThan(before!.y + 20);
  await expect(page.getByTestId("ove-dirty")).toHaveText("저장 안 한 변경 2개");

  // 위젯 끄기·켜기: 명예의 전당은 기본 템플릿에 없다 → 켜면 새로 생긴다
  await page.getByLabel("명예의 전당 보이기").check();
  await expect(page.getByTestId("ove-dirty")).toHaveText("저장 안 한 변경 3개");

  // 되돌리기·다시 실행(Ctrl+Z · Ctrl+Shift+Z): 명예의 전당 켜기를 되돌렸다가 다시 실행
  await page.getByRole("button", { name: "되돌리기" }).click();
  await expect(page.getByTestId("ove-dirty")).toHaveText("저장 안 한 변경 2개");
  await page.getByRole("button", { name: "다시 실행" }).click();
  await expect(page.getByTestId("ove-dirty")).toHaveText("저장 안 한 변경 3개");
  await page.getByTestId("ove-canvas").focus();
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("ove-dirty")).toHaveText("저장 안 한 변경 2개");
  await page.keyboard.press("Control+Shift+z");
  await expect(page.getByTestId("ove-dirty")).toHaveText("저장 안 한 변경 3개");

  await page.getByRole("button", { name: "저장하기" }).click();
  await expect(toast(page)).toContainText("저장했습니다 · 방송 화면에 바로 반영됩니다");
  await expect(page.getByTestId("ove-dirty")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "되돌리기" })).toBeDisabled();

  const saved = await layout(page);
  const cur = saved.widgets.find((w) => w.id === "current")!;
  expect(cur.y).toBe(40);
  expect(saved.widgets.some((w) => w.type === "HALL_OF_FAME" && w.visible)).toBe(true);
  expect(saved.version).toBeGreaterThan(0);

  // 오버레이 화면이 저장한 배치대로(위치 %)
  const t = await call<{ token: string }>(page, "/api/seller/overlay/token", "POST", {});
  const ov = await context.newPage();
  await ov.setViewportSize({ width: 1080, height: 1920 });
  await ov.goto(`/overlay/${t.data.token}`);
  await expect(ov.locator('[data-widget="HALL_OF_FAME"]')).toBeVisible();
  await expect(ov.locator('[data-widget="HALL_OF_FAME"]')).toHaveCSS("position", "absolute");

  // 편집기에서 다시 저장하면 열려 있는 오버레이가 15초 안에 바뀐다
  await page.getByLabel("명예의 전당 보이기").uncheck();
  await page.getByRole("button", { name: "저장하기" }).click();
  await expect(toast(page)).toContainText("저장했습니다");
  await expect(ov.locator('[data-widget="HALL_OF_FAME"]')).toHaveCount(0, { timeout: 25_000 });
  await ov.close();
  await reset(page);
});

test("다른 창에서 먼저 저장했으면 안내하고, 다시 불러오면 최신으로 바뀐다", async ({ page, context }) => {
  await login(page);
  await reset(page);
  await page.reload();
  await expect(page.getByTestId("ove-canvas")).toBeVisible();

  await page.getByRole("button", { name: "현재 주문", exact: true }).click();
  await page.getByLabel("가로 위치").fill("10");

  // 다른 창(같은 로그인)이 먼저 저장
  const other = await context.newPage();
  await other.goto("/seller/overlay");
  await expect(other.getByTestId("ove-canvas")).toBeVisible();
  const l = await layout(other);
  const put = await call(other, "/api/seller/overlay/layout", "PUT", { aspect: "9x16", widgets: l.widgets, expectedVersion: l.version });
  expect(put.status).toBe(200);
  await other.close();

  await page.getByRole("button", { name: "저장하기" }).click();
  await expect(page.getByTestId("ove-conflict")).toContainText("다른 창에서 세로 9:16 레이아웃을 먼저 저장했습니다");
  await page.getByRole("button", { name: "최신 내용 불러오기" }).click();
  await expect(page.getByTestId("ove-conflict")).toHaveCount(0);
  await expect(page.getByTestId("ove-dirty")).toHaveCount(0);
  await reset(page);
});

test("템플릿으로 초기화(초안)하고 되돌릴 수 있으며, 내 템플릿을 저장·적용·삭제한다", async ({ page }) => {
  await login(page);
  await reset(page);
  await page.reload();
  await expect(page.getByTestId("ove-canvas")).toBeVisible();

  // 스포트라이트로 초기화: 확인 창 → 초안(저장 전)으로 바뀌고, 되돌리기로 돌아간다
  await page.getByRole("button", { name: "현재 주문·명예의 전당 강조" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "초기화" }).click();
  await expect(toast(page)).toContainText("템플릿으로 초기화했습니다");
  await expect(page.getByTestId("ove-dirty")).toBeVisible();
  expect((await layout(page)).widgets.some((w) => w.type === "HALL_OF_FAME")).toBe(false);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await expect(page.getByTestId("ove-dirty")).toHaveCount(0);
  await page.getByRole("button", { name: "다시 실행" }).click();
  await page.getByRole("button", { name: "저장하기" }).click();
  await expect(toast(page)).toContainText("저장했습니다");
  expect((await layout(page)).widgets.some((w) => w.type === "HALL_OF_FAME" && w.visible)).toBe(true);

  // 내 템플릿 저장(N / 20 표시)
  await expect(page.getByTestId("ove-mine")).toContainText("내 템플릿");
  await page.getByRole("button", { name: "내 템플릿으로 저장" }).click();
  await page.getByLabel("템플릿 이름").fill(NAME);
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
  await expect(toast(page)).toContainText("내 템플릿으로 저장했습니다");
  const row = page.getByTestId("ove-mine-row").filter({ hasText: NAME });
  await expect(row).toHaveCount(1);

  // 기본으로 돌린 뒤 저장, 내 템플릿 적용 후 저장
  await page.getByRole("button", { name: "주문대기 중심" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "초기화" }).click();
  await page.getByRole("button", { name: "저장하기" }).click();
  await expect.poll(async () => (await layout(page)).widgets.some((w) => w.type === "HALL_OF_FAME")).toBe(false);
  await row.getByRole("button", { name: "적용" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "초기화" }).click();
  await page.getByRole("button", { name: "저장하기" }).click();
  await expect.poll(async () => (await layout(page)).widgets.some((w) => w.type === "HALL_OF_FAME")).toBe(true);

  // 삭제
  await row.getByRole("button", { name: `${NAME} 삭제` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "삭제" }).click();
  await expect(page.getByTestId("ove-mine-row").filter({ hasText: NAME })).toHaveCount(0);
  await reset(page);
});

test("내 템플릿이 20개면 저장을 막고 안내한다", async ({ page }) => {
  await login(page);
  await reset(page);
  const l = await layout(page);
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await call<{ id: string }>(page, "/api/seller/overlay/templates", "POST", { name: `${NAME}-${i}`, aspect: "9x16", widgets: l.widgets });
    if (r.status === 201) ids.push(r.data.id);
  }
  try {
    await page.reload();
    await expect(page.getByTestId("ove-full")).toContainText("내 템플릿은 20개까지입니다");
    await expect(page.getByRole("button", { name: "내 템플릿으로 저장" })).toBeDisabled();
  } finally {
    for (const id of ids) await call(page, `/api/seller/overlay/templates/${id}`, "DELETE");
  }
});
