import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 플랫폼 공지·문의 e2e 준비(폐기용 테스트 DB). 공지는 마스터 관리자가 쓰는 것이라 DB에 바로 만들고, 문의는 화면으로 보낸 뒤 마스터 답변·종료만 DB로 흉내 낸다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
export const E2E_PREFIX = "E2E-";
const PUBLIC_NOTICE_PREFIX = "E2E-PF-";

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

export async function seedPublicNoticePagesInDb() {
  const db = open();
  try {
    await db.platformNotice.deleteMany({ where: { title: { startsWith: PUBLIC_NOTICE_PREFIX } } });
    const authorId = await adminId(db);
    const base = Date.now() - 60_000;
    const visibleIds: string[] = [];
    for (let i = 0; i < 11; i++) {
      const category = i < 6 ? "FEATURE" : i < 9 ? "POLICY" : "MAINTENANCE";
      const title = i === 4 ? `${PUBLIC_NOTICE_PREFIX}FEATURE-04${"A".repeat(100 - `${PUBLIC_NOTICE_PREFIX}FEATURE-04`.length)}` : `${PUBLIC_NOTICE_PREFIX}${category}-${String(i).padStart(2, "0")}`;
      const row = await db.platformNotice.create({
        data: {
          title,
          body: `첫 줄 ${i}\n둘째 줄 원문`,
          category,
          audience: "PUBLIC",
          publishedAt: new Date(base + (10 - i) * 1000),
          createdByAdminId: authorId,
          updatedByAdminId: authorId,
        },
        select: { id: true },
      });
      visibleIds.push(row.id);
    }
    const pinned = await db.platformNotice.create({
      data: {
        title: `${PUBLIC_NOTICE_PREFIX}PIN`,
        body: "고정 공지 본문",
        category: "MAINTENANCE",
        audience: "PUBLIC",
        isPinned: true,
        publishedAt: new Date(base + 20_000),
        createdByAdminId: authorId,
        updatedByAdminId: authorId,
      },
      select: { id: true },
    });
    const hiddenIds: string[] = [];
    const hiddenRows = [
      { name: "PARTNERS", audience: "PARTNERS" as const, publishedAt: new Date(base + 30_000) },
      { name: "UNPUBLISHED", audience: "PUBLIC" as const, publishedAt: null },
      { name: "DELETED", audience: "PUBLIC" as const, publishedAt: new Date(base + 40_000), deletedAt: new Date() },
      { name: "FUTURE", audience: "PUBLIC" as const, publishedAt: new Date(Date.now() + 86_400_000) },
    ];
    for (const { name, ...values } of hiddenRows) {
      const row = await db.platformNotice.create({
        data: {
          title: `${PUBLIC_NOTICE_PREFIX}${name}`,
          body: "숨겨져야 하는 공지",
          category: "GENERAL",
          createdByAdminId: authorId,
          updatedByAdminId: authorId,
          ...values,
        },
        select: { id: true },
      });
      hiddenIds.push(row.id);
    }
    return { visibleIds, hiddenIds, pinnedId: pinned.id };
  } finally {
    await db.$disconnect();
  }
}

export async function cleanupPublicNoticePagesInDb() {
  const db = open();
  try {
    await db.platformNotice.deleteMany({ where: { title: { startsWith: PUBLIC_NOTICE_PREFIX } } });
  } finally {
    await db.$disconnect();
  }
}

// 공지에 첨부 한 개를 붙인다(공지는 지울 때 같이 지워진다)
export async function addNoticeFileInDb(noticeId: string, name: string, text: string) {
  const db = open();
  try {
    const data = Buffer.from(text, "utf8");
    await db.platformNoticeFile.create({ data: { noticeId, name, data, contentType: "text/plain", byteSize: data.length, createdByAdminId: await adminId(db) } });
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

// 하루 한도(쇼핑몰당 24시간 20건)를 채운다. cleanupPlatformE2eInDb가 지운다.
export async function fillInquiryLimitInDb(count: number) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug: "demo-shop" } });
    const owner = await db.sellerUser.findFirstOrThrow({ where: { sellerId: seller.id, isOwner: true }, select: { id: true } });
    await db.platformInquiry.createMany({
      data: Array.from({ length: count }, (_, i) => ({ sellerId: seller.id, createdBySellerUserId: owner.id, category: "OTHER" as const, title: `${E2E_PREFIX}한도 ${i}` })),
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
