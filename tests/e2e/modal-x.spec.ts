import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 공통 모달(components/admin-ui/Modal, 대표님 지시 2026-10-04 「전체 모달 우측 상단에 X 버튼」):
// 파트너스 관리자 모달 3종(오버레이 주소 발급 확인·쿠폰 만들기·직원 정보 · 권한 수정)에서 X가 오른쪽 위에 보이고,
// X·Esc·바깥 클릭으로 닫히며, 열릴 때 포커스가 모달 안에 있고 Tab이 모달 밖으로 나가지 않는다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function open(page: Page, path: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent(path)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, "\\/")}$`));
}

const MODALS: { name: string; path: string; opener: string | RegExp }[] = [
  { name: "오버레이 주소 발급 확인", path: "/seller/overlay", opener: "주소 발급" },
  { name: "쿠폰 만들기", path: "/seller/coupons", opener: "쿠폰 만들기" },
  { name: "직원 정보 · 권한 수정", path: "/seller/staff", opener: /정보 · 권한 수정$/ },
];

for (const m of MODALS) {
  test(`${m.name} 모달: X가 오른쪽 위에 보이고 X·Esc·바깥 클릭으로 닫히며 포커스가 모달 안에 갇힌다`, async ({ page }) => {
    await open(page, m.path);
    const trigger = page.getByRole("button", { name: m.opener }).first();
    const dialog = page.getByRole("dialog");

    // X: 모달 오른쪽 위 모서리 안쪽(위·오른쪽 끝에서 16px 이내)
    await trigger.click();
    await expect(dialog).toBeVisible();
    const x = dialog.getByRole("button", { name: "닫기", exact: true }).and(dialog.locator(".modal-x"));
    await expect(x).toBeVisible();
    const box = (await dialog.locator(".modal").boundingBox())!;
    const xb = (await x.boundingBox())!;
    expect(xb.x + xb.width).toBeLessThanOrEqual(box.x + box.width);
    expect(box.x + box.width - (xb.x + xb.width)).toBeLessThanOrEqual(16);
    expect(xb.y - box.y).toBeLessThanOrEqual(16);
    expect(xb.y).toBeGreaterThanOrEqual(box.y);

    // 포커스는 모달 안, Tab을 여러 번 눌러도 모달 안에 머문다
    expect(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
    }

    // X로 닫기 → 열었던 버튼으로 포커스가 돌아온다
    await x.click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Esc로 닫기
    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // 바깥(어두운 바탕) 클릭으로 닫기
    await trigger.click();
    await expect(dialog).toBeVisible();
    await dialog.click({ position: { x: 4, y: 4 } });
    await expect(dialog).toHaveCount(0);
  });
}
