import type { PrismaClient } from "@prisma/client";
import { dbNow } from "../billing/subscription";

// 후속 처리 대상이 남아 있는지(MASTER 정의 2026-10-04, 화면 셸이 오버레이 전용으로 내린 뒤에도 주문·배송·문의 메뉴를 계속 보여 줄지 정한다).
// ORDER_FOLLOWUP 경로(`/api/seller/orders/**`·`shipments/**`·`purchase-restrictions/**`·`members/**`)가 다루는 후속 대상 전부다:
//  - 끝나지 않은 주문: 결제 대기(입금 확인·취소), 결제 완료인데 아직 배송 완료가 아닌 주문(발송 전·배송 중·재고 부족 환불 대기).
//    탈퇴 회원 보관 주문(legalHoldAt)은 일반 조회에서 없는 주문이라 세지 않는다(buyers/withdraw.ts의 「진행 중 주문」과 같은 기준).
//  - 유효한 구매 제한: 풀리지 않았고 끝나는 시각 전(마지막 주문을 끝내도 30일 제한이 남아 있으면 true).
// 판정은 이 함수 하나만 쓴다. 접근 권한(기능 권한이 하나라도 있음)은 호출하는 쪽이 따로 본다.
export async function hasOrderFollowup(db: PrismaClient, sellerId: string, now?: Date): Promise<boolean> {
  const at = now ?? (await dbNow(db));
  const [order, restriction] = await Promise.all([
    db.order.findFirst({
      where: {
        sellerId,
        legalHoldAt: null,
        OR: [
          { status: "PENDING_PAYMENT" },
          { status: "PAID", OR: [{ shipment: { is: null } }, { shipment: { is: { status: { not: "DELIVERED" } } } }] },
        ],
      },
      select: { id: true },
    }),
    db.buyerPurchaseRestriction.findFirst({ where: { sellerId, liftedAt: null, endsAt: { gt: at } }, select: { id: true } }),
  ]);
  return order !== null || restriction !== null;
}
