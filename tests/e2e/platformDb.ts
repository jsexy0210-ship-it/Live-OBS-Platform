import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 플랫폼 공지·문의 e2e 준비(폐기용 테스트 DB). 공지는 마스터 관리자가 쓰는 것이라 DB에 바로 만들고, 문의는 화면으로 보낸 뒤 마스터 답변·종료만 DB로 흉내 낸다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
export const E2E_PREFIX = "E2E-";

// 마스터 관리자 행이 없는 DB(시드에 없음)에서도 쓸 수 있게, 로그인할 수 없는 시험용 CS 계정을 한 번 만들어 쓴다
async function adminId(db: PrismaClient) {
  const a = await db.platformAdmin.upsert({
    where: { email: "e2e-cs@example.invalid" },
    create: { email: "e2e-cs@example.invalid", passwordHash: "!", name: "시험 CS", role: "CS" },
    update: {},
    select: { id: true },
  });
  return a.id;
}

export async function createNoticeInDb(title: string, opts: { pinned?: boolean; audience?: "PARTNERS" | "PUBLIC" | "ALL"; category?: "MAINTENANCE" | "POLICY" | "FEATURE" | "GENERAL"; body?: string } = {}) {
  const db = open();
  try {
    const admin = { id: await adminId(db) };
    const n = await db.platformNotice.create({
      data: {
        title: E2E_PREFIX + title,
        body: opts.body ?? "내용입니다.\n둘째 줄입니다.",
        category: opts.category ?? "GENERAL",
        audience: opts.audience ?? "PARTNERS",
        isPinned: opts.pinned ?? false,
        publishedAt: new Date(),
        createdByAdminId: admin.id,
        updatedByAdminId: admin.id,
      },
      select: { id: true },
    });
    return n.id;
  } finally {
    await db.$disconnect();
  }
}

export async function adminReplyInDb(inquiryId: string, body: string, close = false) {
  const db = open();
  try {
    const admin = { id: await adminId(db) };
    const inq = await db.platformInquiry.findUniqueOrThrow({ where: { id: inquiryId }, select: { sellerId: true } });
    const now = new Date();
    await db.platformInquiryMessage.create({ data: { sellerId: inq.sellerId, inquiryId, authorType: "ADMIN", adminId: admin.id, body, createdAt: now } });
    await db.platformInquiry.update({
      where: { id: inquiryId },
      data: { status: close ? "CLOSED" : "ANSWERED", lastMessageAt: now, lastAdminMessageAt: now, ...(close ? { closedAt: now, closedByAdminId: admin.id } : {}) },
    });
  } finally {
    await db.$disconnect();
  }
}

export async function cleanupPlatformE2eInDb() {
  const db = open();
  try {
    await db.platformInquiry.deleteMany({ where: { title: { startsWith: E2E_PREFIX } } });
    await db.platformNotice.deleteMany({ where: { title: { startsWith: E2E_PREFIX } } });
  } finally {
    await db.$disconnect();
  }
}
