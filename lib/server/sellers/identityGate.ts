import type { PrismaClient } from "@prisma/client";
import { AuthError } from "../authz/errors";

// 본인확인 대기 쇼핑몰: 마스터 최고관리자가 직접 추가했고(Seller.directCreatedByAdminId) 대표자 본인확인이 아직 안 된(representativeVerifiedAt 없음) 쇼핑몰.
// 본인확인 계약 전 임시 경로라, 돈이 오가거나 대표자 CI에 기대는 기능은 본인확인이 끝날 때까지 막는다:
// 직원 추가(직원 본인확인 연결이 대표자 CI에 기대), 적립금 실지급 켜기, 발송·이용 충전금 결제. 셀프 아이디/비밀번호 찾기는 대표자 CI가 없어 기존 흐름이 이미 거부한다.
// 로그인·상품·방송·오버레이·주문 처리는 막지 않는다.
export const IDENTITY_PENDING_CODE = "identity_pending";
export const IDENTITY_PENDING_MESSAGE = "대표자 본인확인이 끝나면 쓸 수 있습니다. 본인확인 전에는 이 기능을 쓸 수 없습니다";

export async function isIdentityPending(db: Pick<PrismaClient, "seller">, sellerId: string): Promise<boolean> {
  const s = await db.seller.findUnique({ where: { id: sellerId }, select: { directCreatedByAdminId: true, representativeVerifiedAt: true } });
  return !!s && s.directCreatedByAdminId !== null && s.representativeVerifiedAt === null;
}

export async function assertIdentityVerified(db: Pick<PrismaClient, "seller">, sellerId: string): Promise<void> {
  if (await isIdentityPending(db, sellerId)) throw new AuthError(403, IDENTITY_PENDING_CODE);
}
