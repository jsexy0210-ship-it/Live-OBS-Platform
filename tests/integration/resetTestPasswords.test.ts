import { execFileSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loginAdmin, loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { PASSWORD, adminCredentials, createAdmin, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

// 서버에서처럼 운영 빌드(NODE_ENV=production)로 돌린다.
function run(extra: Record<string, string>) {
  try {
    const out = execFileSync("node", ["scripts/reset-test-passwords.mjs"], {
      env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: "production", ...extra },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}
const meta = { ip: "127.0.0.1", userAgent: "vitest" };

describe("테스트 서버 비밀번호 통일 명령(scripts/reset-test-passwords.mjs)", () => {
  it("OBS_TEST_MODE=1이 없으면 아무것도 바꾸지 않고 실패한다", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const r = run({});
    expect(r.code).not.toBe(0);
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: owner.id } })).passwordHash).toBe(owner.passwordHash);
  });

  it("판매자 계정·구매자 회원은 1234로 로그인되고, 마스터 관리자와 탈퇴 회원은 그대로다. 출력에 아이디가 없다", async () => {
    const { seller, grade } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const staff = await createSellerUser(seller.id, "MANAGER");
    const buyer = await createLoginBuyer(seller.id, grade.id);
    const gone = await createLoginBuyer(seller.id, grade.id);
    await db.buyerMember.update({ where: { id: gone.id }, data: { status: "WITHDRAWN", deletedAt: new Date() } });
    const admin = await createAdmin("SUPER_ADMIN");

    const r = run({ OBS_TEST_MODE: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("판매자 계정 2개");
    expect(r.out).toContain("구매자 회원 1명");
    for (const s of [owner.email, staff.email, buyer.loginId, admin.email]) expect(r.out).not.toContain(s);

    expect((await loginSeller(prisma, { email: owner.email, password: "1234" }, meta)).ok).toBe(true);
    expect((await loginSeller(prisma, { email: staff.email, password: "1234" }, meta)).ok).toBe(true);
    expect((await loginBuyer(prisma, { sellerId: seller.id, loginId: buyer.loginId, password: "1234" }, meta)).ok).toBe(true);
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: owner.id } })).credentialVersion).toBe(owner.credentialVersion + 1);
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: gone.id } })).passwordHash).toBe(gone.passwordHash);
    expect((await loginAdmin(prisma, adminCredentials(admin), meta)).ok).toBe(true);
    expect((await loginAdmin(prisma, { email: admin.email, password: "1234" }, meta)).ok).toBe(false);
    expect(PASSWORD).not.toBe("1234");
  });
});
