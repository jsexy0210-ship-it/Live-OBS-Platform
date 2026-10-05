import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { cleanText } from "../text/clean";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 파트너스 회원 메모(SA-042, MEMBER_POINTS). 회원마다 1건을 덮어쓰고 작성자·수정 시각을 남긴다.
// 항상 ctx.sellerId 범위만 보고, 탈퇴·다른 쇼핑몰 회원은 없음(404)으로 다룬다. 빈 글을 저장하면 메모를 지운다.
// 자유 입력이라 개인정보가 섞일 수 있어 탈퇴 때 지우고(buyers/withdraw.ts), 로그 추적에는 본문 없이 글자 수만 남긴다.
export const MEMBER_MEMO_MAX = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireMember(db: Pick<PrismaClient, "buyerMember">, ctx: TenantContext, memberId: string) {
  if (!UUID_RE.test(memberId)) throw notFound();
  const m = await db.buyerMember.findFirst({ where: { id: memberId, sellerId: ctx.sellerId, deletedAt: null }, select: { id: true } });
  if (!m) throw notFound();
}

export async function getMemberMemo(db: PrismaClient, ctx: TenantContext, memberId: string) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  await requireMember(db, ctx, memberId);
  const memo = await db.memberMemo.findUnique({ where: { sellerId_buyerMemberId: { sellerId: ctx.sellerId, buyerMemberId: memberId } } });
  if (!memo) return null;
  const author = memo.updatedById ? await db.sellerUser.findFirst({ where: { id: memo.updatedById, sellerId: ctx.sellerId }, select: { name: true } }) : null;
  return { body: memo.body, createdAt: memo.createdAt, updatedAt: memo.updatedAt, updatedBy: author ? { name: author.name } : null };
}

// 메모 저장. 빈 글(공백만 포함)이면 지운다. 글자가 잘못됐거나 1,000자를 넘으면 { ok: false }.
export async function putMemberMemo(db: PrismaClient, ctx: TenantContext, memberId: string, raw: unknown) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  const clear = typeof raw === "string" && raw.trim() === "";
  const body = clear ? null : cleanText(raw, MEMBER_MEMO_MAX, "multiline");
  if (!clear && body === null) return { ok: false as const, reason: "invalid_memo" as const };
  const sellerId = ctx.sellerId;
  const key = { sellerId_buyerMemberId: { sellerId, buyerMemberId: memberId } };
  const by = ctx.actorType === "SELLER_USER" ? ctx.actorId : null;
  await db.$transaction(async (tx) => {
    await requireMember(tx, ctx, memberId);
    const base = { actorType: ctx.actorType, actorId: ctx.actorId, sellerId, targetType: "BuyerMember", targetId: memberId };
    if (body === null) {
      const gone = await tx.memberMemo.deleteMany({ where: { sellerId, buyerMemberId: memberId } });
      if (gone.count > 0) await writeAudit(tx, { ...base, action: "member.memo.delete" });
      return;
    }
    const before = await tx.memberMemo.findUnique({ where: key, select: { body: true } });
    await tx.memberMemo.upsert({
      where: key,
      create: { sellerId, buyerMemberId: memberId, body, updatedById: by },
      update: { body, updatedById: by, updatedAt: new Date() },
    });
    await writeAudit(tx, { ...base, action: "member.memo.update", before: before ? { length: [...before.body].length } : null, after: { length: [...body].length } });
  });
  return { ok: true as const, memo: await getMemberMemo(db, ctx, memberId) };
}
