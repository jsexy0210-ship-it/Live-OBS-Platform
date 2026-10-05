import type { PrismaClient, SellerStatus } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";

// 마스터 관리자 파트너스 목록·상세(MA-011·012, platform.read)와 이용 정지·해제(MA-015, seller.moderate).
// 목록·요약·내려받기는 sellerList.ts. 판매자 권한으로는 이 경로에 들어올 수 없다(관리자 세션만).
const DAY_MS = 86_400_000;
type Meta = { ip?: string | null; userAgent?: string | null };

function requireRead(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
}

// 파트너스 상세: 기본 정보·대표자·구독·최근 30일 주문 요약. 없으면 null.
export async function getAdminSeller(db: PrismaClient, admin: AdminSessionContext, sellerId: string, meta: Meta = {}) {
  requireRead(admin);
  const s = await db.seller.findUnique({
    where: { id: sellerId },
    select: {
      id: true,
      slug: true,
      shopName: true,
      status: true,
      businessInfo: true,
      reviewReasons: true,
      suspendedReason: true,
      rejectedReason: true,
      rejectedAt: true,
      businessCategory: true,
      supplementRequestedAt: true,
      supplementMessage: true,
      supplementRemindedAt: true,
      supplementReminderCount: true,
      approvedAt: true,
      trialEndsAt: true,
      serviceEndedAt: true,
      createdAt: true,
      plan: { select: { code: true, name: true } },
      users: { where: { isOwner: true }, select: { name: true, email: true, status: true, lastLoginAt: true }, take: 1 },
      subscription: {
        select: {
          status: true,
          cardLabel: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          nextChargeAt: true,
          cancelAtPeriodEnd: true,
          graceUntil: true,
          retryCount: true,
          plan: { select: { code: true, name: true } },
          pendingPlan: { select: { code: true, name: true } },
        },
      },
    },
  });
  if (!s) return null;
  // 대표자 이메일·사업자 정보는 마스터 관리자 전 역할이 본다(대표님 결정 2026-10-04 「모두 보기」). 대신 열람할 때마다 로그 추적을 남긴다.
  await writeAudit(db, {
    actorType: "PLATFORM_ADMIN",
    actorId: admin.admin.id,
    sellerId,
    action: "admin.seller.view",
    targetType: "Seller",
    targetId: sellerId,
    after: { fields: ["owner", "businessInfo"] },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  const now = await dbNow(db);
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const [orders, paid, lastOrder] = await Promise.all([
    db.order.count({ where: { sellerId, createdAt: { gte: since } } }),
    db.order.aggregate({ where: { sellerId, paidAt: { gte: since } }, _count: true, _sum: { totalAmount: true, refundAmount: true } }),
    db.order.findFirst({ where: { sellerId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  const { users, subscription, ...rest } = s;
  return {
    ...rest,
    owner: users[0] ?? null,
    subscription: subscription
      ? {
          ...subscription,
          plan: undefined,
          pendingPlan: undefined,
          // 화면은 이름을 보여 준다(코드성 표기 금지), 코드는 분기용
          planCode: subscription.plan.code,
          planName: subscription.plan.name,
          pendingPlanCode: subscription.pendingPlan?.code ?? null,
          pendingPlanName: subscription.pendingPlan?.name ?? null,
        }
      : null,
    // 최근 30일: 들어온 주문 수, 결제된 주문 수·결제 금액(환불액 뺌), 마지막 주문 시각
    orders30d: {
      since,
      created: orders,
      paid: paid._count,
      paidAmount: (paid._sum.totalAmount ?? 0) - (paid._sum.refundAmount ?? 0),
      lastOrderAt: lastOrder?.createdAt ?? null,
    },
  };
}

// 이용 정지(운영 중 → 정지, 사유 1~200자 필수)·해제(정지 → 운영 중). 대표님 결정(2026-10-04) 「신규만 막기」: 정지되면 구매자 쇼핑몰의
// 새 주문·가입, 오버레이 공개 주소, 파트너스의 방송·상품·설정·결제가 막히고(authz/guards.ts sellerSuspended), 구독 자동결제도 멈춘다.
// 이미 받은 주문의 배송·환불(ORDER_FOLLOWUP 경로)과 내 정보·구독 조회는 파트너스가 계속 쓴다. 해제하면 다음 예약 실행부터 자동결제가 다시 돈다.
// 지금 상태가 아니면 409 not_suspendable·not_suspended, 없으면 not_found. 로그 추적 admin.seller.suspend·unsuspend.
export async function setSellerSuspended(
  db: PrismaClient,
  admin: AdminSessionContext,
  sellerId: string,
  input: { suspend: boolean; reason?: unknown },
  meta: Meta = {},
) {
  if (!adminCan(admin.admin.role, "seller.moderate")) throw forbidden();
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (input.suspend && (!reason || reason.length > 200)) return { ok: false as const, reason: "reason_required" as const };
  return db.$transaction(async (tx) => {
    const [cur] = await tx.$queryRaw<{ status: SellerStatus; suspendedReason: string | null }[]>`
      SELECT "status", "suspendedReason" FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR UPDATE`;
    if (!cur) return { ok: false as const, reason: "not_found" as const };
    if (input.suspend ? cur.status !== "ACTIVE" : cur.status !== "SUSPENDED") {
      return { ok: false as const, reason: input.suspend ? ("not_suspendable" as const) : ("not_suspended" as const) };
    }
    const status: SellerStatus = input.suspend ? "SUSPENDED" : "ACTIVE";
    await tx.seller.update({ where: { id: sellerId }, data: { status, suspendedReason: input.suspend ? reason : null } });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      sellerId,
      action: input.suspend ? "admin.seller.suspend" : "admin.seller.unsuspend",
      targetType: "Seller",
      targetId: sellerId,
      reason: reason || undefined,
      before: { status: cur.status, suspendedReason: cur.suspendedReason },
      after: { status },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, status };
  });
}
