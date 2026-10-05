import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// 관리자 화면 바깥 테두리(대표님 지시 2026-10-05: 「외곽 프레임 제거」를 철회하고 검색 영역·카드·상태 상자의 바깥 테두리를 복구).
// ① 검색 상자(.au-sb)·카드(.card)·상태 상자(.st, 카드 밖)·방송 요약 칸(.bc-sum-g)은 네 변 1px 테두리가 있어야 한다.
// ③ 바깥 상자 모서리는 모두 12px(검색 영역·카드·목록·상태 상자·요약 칸 묶음, MASTER 2026-10-05).
// ② 이중선 0건: 테두리 상자의 한 변에 안쪽 요소의 선(표 위 선·마지막 행 아래 선·안쪽 상자 테두리 등)이 1px 이내로 맞닿으면 안 된다.
// 1440·1280·1024에서 잰다. E2E_SCREENSHOTS=1이면 화면을 tests/e2e/screenshots/ui-frames/에 남긴다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const adminPassword = randomBytes(12).toString("base64url");
const adminEmail = `frame-super-${randomBytes(4).toString("hex")}@example.com`;
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
let db: PrismaClient;

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email: adminEmail, passwordHash: await hashPassword(adminPassword), name: "대표", role: "SUPER_ADMIN" } });
});
test.afterAll(async () => {
  await db.$disconnect();
});

type Found = { missing: string[]; double: string[]; radius: string[]; framed: number };

async function inspect(page: Page): Promise<Found> {
  // 방송 화면은 실시간 연결이 계속 열려 있어 networkidle이 오지 않는다. 불러오기 끝 + 짧은 대기로 그린 뒤 잰다
  await page.waitForLoadState("load");
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    type Side = "top" | "right" | "bottom" | "left";
    const SIDES: Side[] = ["top", "right", "bottom", "left"];
    const CONTROLS = "input,select,textarea,button,.btn,.inp,.chip,.seg,.pg,.bdg,.cbx,.rdo,.sw,.kbd,img,svg";
    // 요소가 어느 변에 1px 선을 그리는지(border 또는 inset box-shadow)
    const lines = (el: Element): Set<Side> => {
      const c = getComputedStyle(el);
      const out = new Set<Side>();
      const bw = { top: c.borderTopWidth, right: c.borderRightWidth, bottom: c.borderBottomWidth, left: c.borderLeftWidth };
      const bs = { top: c.borderTopStyle, right: c.borderRightStyle, bottom: c.borderBottomStyle, left: c.borderLeftStyle };
      for (const s of SIDES) if (parseFloat(bw[s]) >= 1 && bs[s] !== "none") out.add(s);
      for (const part of c.boxShadow.split(/,(?![^(]*\))/)) {
        if (!part.includes("inset")) continue;
        const n = (part.match(/-?\d+(\.\d+)?px/g) ?? []).map(parseFloat);
        const [x, y, blur = 0, spread = 0] = n;
        if (blur !== 0) continue;
        if (spread >= 1) SIDES.forEach((s) => out.add(s));
        else {
          if (y >= 1) out.add("top");
          if (y <= -1) out.add("bottom");
          if (x >= 1) out.add("left");
          if (x <= -1) out.add("right");
        }
      }
      return out;
    };
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.classList.length ? "." + [...el.classList].join(".") : ""}`;
    const visible = (el: HTMLElement) => el.offsetParent !== null && el.getBoundingClientRect().width > 0;

    const frames = [...document.querySelectorAll<HTMLElement>(".main .au-sb, .main .card, .main .st, .main .bc-sum-g")].filter(
      (el) => visible(el) && !(el.classList.contains("st") && el.closest(".card") && !el.classList.contains("card")),
    );
    const r: Found = { missing: [], double: [], radius: [], framed: frames.length };
    for (const f of frames) {
      const own = lines(f);
      if (SIDES.some((s) => !own.has(s))) {
        r.missing.push(name(f));
        continue;
      }
      // 바깥 상자 모서리는 모두 12(카드 토큰). 컨트롤만 8
      const rad = getComputedStyle(f).borderTopLeftRadius;
      if (rad !== "12px") r.radius.push(`${name(f)} ${rad}`);
      const fb = f.getBoundingClientRect();
      for (const d of f.querySelectorAll<HTMLElement>("*")) {
        if (!visible(d) || d.closest(CONTROLS)) continue;
        const dl = lines(d);
        if (dl.size === 0) continue;
        const db = d.getBoundingClientRect();
        const touch: Record<Side, boolean> = {
          top: Math.abs(db.top - fb.top) <= 1.5,
          bottom: Math.abs(db.bottom - fb.bottom) <= 1.5,
          left: Math.abs(db.left - fb.left) <= 1.5,
          right: Math.abs(db.right - fb.right) <= 1.5,
        };
        for (const s of SIDES) if (dl.has(s) && touch[s]) r.double.push(`${name(f)} ${s} ← ${name(d)}`);
      }
    }
    r.double = [...new Set(r.double)];
    r.missing = [...new Set(r.missing)];
    r.radius = [...new Set(r.radius)];
    return r;
  });
}

const SELLER = ["/seller/orders", "/seller/orders/deposits", "/seller/products", "/seller/products/stock", "/seller/products/categories", "/seller/products/display", "/seller/coupons", "/seller/members", "/seller/rewards", "/seller/rewards/ledger", "/seller/staff", "/seller/shipping", "/seller/hit-cards", "/seller/broadcast", "/seller/settings/shop", "/seller/settings/order", "/seller/subscription"];
const ADMIN = ["/admin", "/admin/partners", "/admin/partners/applications", "/admin/accounts", "/admin/logs", "/admin/billing/invoices", "/admin/billing/subscriptions", "/admin/settings/messages", "/admin/support/notices", "/admin/ops/monitor"];

for (const width of [1440, 1280, 1024]) {
  test(`관리자 본문: 검색 영역·카드·상태 상자 바깥 테두리 있음, 이중선 없음 ${width}px`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/seller/login?next=${encodeURIComponent("/seller/orders")}`);
    await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
    await expect(page).toHaveURL(/\/seller\/orders$/);
    const missing: Record<string, string[]> = {};
    const double: Record<string, string[]> = {};
    const radius: Record<string, string[]> = {};
    let framed = 0;
    const check = async (path: string, shot: string) => {
      await page.goto(path);
      const r = await inspect(page);
      framed += r.framed;
      if (r.missing.length) missing[path] = r.missing;
      if (r.double.length) double[path] = r.double;
      if (r.radius.length) radius[path] = r.radius;
      if (SHOTS) await page.screenshot({ path: `tests/e2e/screenshots/ui-frames/${shot}-${width}.png` });
    };
    for (const path of SELLER) await check(path, `seller${path.replace(/\//g, "-")}`);
    await page.context().clearCookies();
    await page.goto("/admin/login");
    await page.getByLabel("이메일").fill(adminEmail);
    await page.getByLabel("비밀번호").fill(adminPassword);
    await page.getByRole("button", { name: "로그인" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    for (const path of ADMIN) await check(path, `admin${path.replace(/\//g, "-")}`);
    expect.soft(missing, "바깥 테두리가 없는 검색 영역·카드·상태 상자").toEqual({});
    expect.soft(double, "테두리 상자 가장자리에 맞닿은 안쪽 선(이중선)").toEqual({});
    expect.soft(radius, "바깥 상자 모서리가 12px이 아님").toEqual({});
    // 실제로 테두리 상자를 잰 것인지(빈 화면만 보고 통과하지 않게)
    expect(framed).toBeGreaterThan(20);
  });
}
