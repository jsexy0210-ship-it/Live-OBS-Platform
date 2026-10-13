import { expect, test } from "@playwright/test";

// AU-009 공통 404: 영역별 말투(공개 해요체, 파트너스 합니다체)와 다음 행동 버튼.
// 마스터 관리자(/admin) 404는 로그인 뒤에만 보여 로그인 없는 이 시험에서는 확인하지 않는다.
test("없는 주소는 영역에 맞는 404를 보여 준다", async ({ page }) => {
  const cases = [
    { path: "/no-such-page", title: "페이지를 찾을 수 없어요", cta: "홈으로", href: "/about" },
    { path: "/seller/no-such-page", title: "페이지를 찾을 수 없습니다", cta: "대시보드로", href: "/seller" },
  ];
  for (const c of cases) {
    const res = await page.goto(c.path);
    expect(res?.status(), c.path).toBe(404);
    await expect(page.getByRole("heading", { level: 1 }), c.path).toHaveText(c.title);
    await expect(page.getByRole("link", { name: c.cta }), c.path).toHaveAttribute("href", c.href);
    if (!c.path.startsWith("/seller")) {
      await expect(page.getByText("주소가 바뀌었거나 지워졌어요. 주소를 다시 확인하거나 홈으로 가 주세요.")).toBeVisible();
      await expect(page.getByRole("link", { name: "자주 묻는 질문" })).toHaveAttribute("href", "/faq");
    }
    await expect(page.getByText("This page could not be found")).toHaveCount(0);
  }
});

// 로그인 없이 /admin 아래 없는 주소를 열면 관리자 셸이 로그인 화면으로 보낸다(기본 영어 404가 아님).
// 로그인한 관리자의 404(합니다체·「홈으로」)는 (admin)/not-found.tsx가 받는다.
test("로그인 없이 관리자 아래 없는 주소는 로그인 화면이 보이고 기본 영어 404가 아니다", async ({ page }) => {
  await page.goto("/admin/no-such-page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("마스터 관리자");
  await expect(page.getByText("This page could not be found")).toHaveCount(0);
});
