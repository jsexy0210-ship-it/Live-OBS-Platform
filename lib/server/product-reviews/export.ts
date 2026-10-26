import type { PrismaClient, ProductReviewStatus } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { orderNoLabel } from "../orders/orderNoLabel";
import { formatCsv, guardText } from "../shop-bulk-io/csv";
import { writeXlsx } from "../shop-bulk-io/xlsx";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { HELD_LABEL } from "./rules";
import { sellerReviewWhere, type SellerReviewQuery } from "./service";

// 리뷰 엑셀 내려받기(SA-048 「엑셀 내려받기」). 목록과 같은 조건(상태·별점·답글 대기·기간·검색어·사진 리뷰만)으로 거른 리뷰를 내려받는다.
// 답글·숨김과 같은 권한(대표자·구매자 문의 직원 INQUIRY_REPLY, 마스터 대리 조회는 불가). 5,000건까지. 내려받은 사실과 조건은 로그 추적(review.export)에 남기고 내용은 남기지 않는다.
// 작성자는 방송 닉네임(탈퇴 회원은 「탈퇴 회원」)이고 이름·연락처는 없다. CSV는 수식처럼 보이는 글자에 작은따옴표를 붙이고(엑셀에서 열 때 실행 방지), 엑셀 파일은 붙이지 않는다.
export const MAX_EXPORT_REVIEWS = 5000;
export const REVIEW_EXPORT_COLUMNS = ["작성일", "주문번호", "상품", "작성자", "등급", "별점", "내용", "사진", "상태", "답글"] as const;
export const REVIEW_EXPORT_MESSAGES = { too_many_reviews: `리뷰가 ${MAX_EXPORT_REVIEWS}건을 넘어 한 번에 내보낼 수 없습니다. 기간이나 조건을 좁혀 주십시오` } as const;
export type ReviewExportFailure = keyof typeof REVIEW_EXPORT_MESSAGES;

const STATUS_LABEL: Record<ProductReviewStatus, string> = { VISIBLE: "공개", PENDING: "공개 대기", HELD: "보류", HIDDEN: "숨김" };
const KST_MS = 9 * 3_600_000;
const kst = (d: Date) => {
  const k = new Date(d.getTime() + KST_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}.${p(k.getUTCMonth() + 1)}.${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
};

export async function exportSellerReviews(
  db: PrismaClient,
  ctx: TenantContext,
  q: SellerReviewQuery,
  format: "csv" | "xlsx",
): Promise<{ ok: true; value: { csv?: string; xlsx?: Buffer; count: number } } | { ok: false; reason: ReviewExportFailure }> {
  requireSellerPermission(ctx, "INQUIRY_REPLY");
  const where = sellerReviewWhere(ctx, q);
  const count = await db.productReview.count({ where });
  if (count > MAX_EXPORT_REVIEWS) return { ok: false, reason: "too_many_reviews" };
  const guard = (v: string) => (format === "csv" ? guardText(v) : v);
  const reviews = await db.productReview.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      product: { select: { name: true } },
      buyerMember: { select: { status: true, grade: { select: { displayName: true } } } },
      order: { select: { orderNo: true, createdAt: true } },
      _count: { select: { images: true } },
    },
  });
  const rows: string[][] = [[...REVIEW_EXPORT_COLUMNS]];
  for (const r of reviews) {
    const status = r.status === "HELD" && r.heldBy ? `${STATUS_LABEL.HELD} · ${HELD_LABEL[r.heldBy] ?? r.heldBy}` : STATUS_LABEL[r.status];
    rows.push([
      kst(r.createdAt),
      orderNoLabel(r.order.createdAt, r.order.orderNo),
      guard(r.product.name),
      guard(r.authorNickname),
      r.buyerMember.status === "WITHDRAWN" ? "" : guard(r.buyerMember.grade.displayName),
      String(r.rating),
      guard(r.body),
      String(r._count.images),
      status,
      guard(r.reply ?? ""),
    ]);
  }
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "review.export",
    targetType: "ProductReview",
    after: {
      rows: reviews.length,
      format,
      filter: { status: q.status ?? null, rating: q.rating ?? null, waiting: q.waiting === "1", from: q.from ?? null, to: q.to ?? null, searched: !!(q.q ?? "").trim(), field: q.field ?? null, photo: q.photo === "1" },
    },
  });
  return { ok: true, value: format === "csv" ? { csv: formatCsv(rows), count: reviews.length } : { xlsx: writeXlsx(rows, "리뷰"), count: reviews.length } };
}
