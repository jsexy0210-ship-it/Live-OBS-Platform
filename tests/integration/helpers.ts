import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 모듈을 불러오는 순간 테스트 DB인지 확인한다.
const url = assertTestDatabaseUrl(process.env.DATABASE_URL);

export const db = new PrismaClient({ datasources: { db: { url } } });

export async function resetDb(): Promise<void> {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

let seq = 0;
const next = () => ++seq;

export async function createSeller() {
  const n = next();
  const seller = await db.seller.create({ data: { slug: `shop-${n}`, shopName: `쇼핑몰 ${n}`, status: "ACTIVE" } });
  const grade = await db.memberGrade.create({
    data: { sellerId: seller.id, displayName: "일반", sortOrder: 0, systemKey: "BASIC" },
  });
  return { seller, grade };
}

export async function createBuyer(
  sellerId: string,
  gradeId: string,
  phone = `010${String(next()).padStart(8, "0")}`,
  ciHash = `ci-${next()}`,
) {
  const n = next();
  return db.buyerMember.create({
    data: {
      sellerId,
      gradeId,
      loginId: `buyer${n}`,
      passwordHash: "x",
      name: `구매자${n}`,
      phone,
      broadcastNickname: `닉네임${n}`,
      ciHash,
      identityVerifiedAt: new Date(),
    },
  });
}

export async function createPaidOrderItem(sellerId: string, buyerMemberId: string, stock = 10) {
  const product = await db.product.create({ data: { sellerId, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId, productId: product.id, name: "1팩", stock } });
  const order = await db.order.create({
    data: {
      sellerId,
      orderNo: next(),
      buyerMemberId,
      status: "PAID",
      broadcastNicknameSnapshot: "닉네임",
      totalAmount: 5000,
      paidAt: new Date(),
    },
  });
  const item = await db.orderItem.create({
    data: {
      sellerId,
      orderId: order.id,
      productId: product.id,
      optionId: option.id,
      productNameSnapshot: product.name,
      optionNameSnapshot: option.name,
      unitPrice: 5000,
      quantity: 1,
    },
  });
  return { product, option, order, item };
}

export const PASSWORD = "test-password-1";
let pwHash: Promise<string> | undefined;
async function passwordHash() {
  const { hashPassword } = await import("../../lib/server/auth/password");
  pwHash ??= hashPassword(PASSWORD);
  return pwHash;
}

export async function createAdmin(
  role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY",
  extra: { status?: "ACTIVE" | "SUSPENDED"; totpSecretEnc?: string; totpEnabledAt?: Date } = {},
) {
  return db.platformAdmin.create({
    data: { email: `admin${next()}@example.com`, passwordHash: await passwordHash(), name: "관리자", role, ...extra },
  });
}

export async function createSellerUser(sellerId: string, role: "OWNER" | "MANAGER" | "BROADCASTER", email?: string) {
  return db.sellerUser.create({
    data: { sellerId, email: email ?? `staff${next()}@example.com`, passwordHash: await passwordHash(), name: "직원", role },
  });
}

export async function createLoginBuyer(sellerId: string, gradeId: string) {
  const m = await createBuyer(sellerId, gradeId);
  return db.buyerMember.update({ where: { id: m.id }, data: { passwordHash: await passwordHash() } });
}
