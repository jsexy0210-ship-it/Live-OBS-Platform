import type { PrismaClient, ReceiptCertStatus } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";
import { isBizNo } from "./service";

// 현금영수증·전자세금계산서 발행자 정보(SA-024, 대표님 결정 2026-10-05 「영수증은 파트너스 이름으로 발행」).
// 발행은 파트너스(판매자) 명의로 외부 발행 업체를 통해 한다. 여기에는 발행자의 사업자 정보와 인증서 등록 상태만 둔다.
// 인증서 자체는 발행 업체 쪽에 등록하며 이 서버에 저장하지 않는다. 사업자번호를 바꾸면 인증서는 다시 등록해야 해서 상태를 미등록으로 되돌린다.
// 등록 상태는 업체 연동이 확인해 갱신한다(연동 전에는 항상 NOT_REGISTERED). RECEIPT_TAX 권한.
export type ReceiptIssuerView = { businessNumber: string; companyName: string; representative: string; certStatus: ReceiptCertStatus; certCheckedAt: Date | null };
const select = { businessNumber: true, companyName: true, representative: true, certStatus: true, certCheckedAt: true } as const;

export const formatBizNo = (d: string) => `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;

export async function readReceiptIssuer(db: PrismaClient, ctx: TenantContext): Promise<ReceiptIssuerView | null> {
  requireSellerRead(ctx, "RECEIPT_TAX");
  const r = await db.sellerReceiptIssuer.findUnique({ where: { sellerId: ctx.sellerId }, select });
  return r ? { ...r, businessNumber: formatBizNo(r.businessNumber) } : null;
}

export async function saveReceiptIssuer(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "RECEIPT_TAX");
  const b = (raw ?? {}) as Record<string, unknown>;
  const digits = typeof b.businessNumber === "string" || typeof b.businessNumber === "number" ? String(b.businessNumber).replace(/[\s-]/g, "") : "";
  const companyName = cleanText(b.companyName, 100);
  const representative = cleanText(b.representative, 50);
  if (!isBizNo(digits) || !companyName || !representative) return { ok: false as const, reason: "invalid_receipt_issuer" as const };
  return db.$transaction(async (tx) => {
    const before = await tx.sellerReceiptIssuer.findUnique({ where: { sellerId: ctx.sellerId }, select });
    const numberChanged = before !== null && before.businessNumber !== digits;
    const data = { businessNumber: digits, companyName, representative, ...(numberChanged ? { certStatus: "NOT_REGISTERED" as const, certCheckedAt: null } : {}) };
    const row = await tx.sellerReceiptIssuer.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...data }, update: data, select });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "seller.receipt_issuer.update",
      targetType: "Seller",
      targetId: ctx.sellerId,
      before: before && { ...before, businessNumber: formatBizNo(before.businessNumber) },
      after: { ...row, businessNumber: formatBizNo(row.businessNumber) },
    });
    return { ok: true as const, issuer: { ...row, businessNumber: formatBizNo(row.businessNumber) } };
  });
}
