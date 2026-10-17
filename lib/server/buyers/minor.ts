import type { Prisma, PrismaClient } from "@prisma/client";

// 미성년자(만 19세 미만) 구매 정책(SH-009). 판매자가 「미성년자 구매 막기」(BLOCK)를 고른 쇼핑몰만 막는다. 기본은 「고지 후 허용」(NOTICE)이라 막지 않는다.
// 판별은 휴대폰 본인확인 생년월일(BuyerMember.birthDate)로 한다. 생년월일이 없는 회원(예전 가입)은 막는 쇼핑몰에서 본인확인을 다시 해야 한다.
type Db = PrismaClient | Prisma.TransactionClient;

export type MinorPurchaseBlock = "minor_blocked" | "identity_reverify_required";

export const MINOR_MESSAGES = {
  minor_blocked: "이 쇼핑몰은 만 19세 미만은 구매할 수 없어요",
  identity_reverify_required: "나이를 확인할 수 없어요. 본인확인을 다시 해 주세요",
} as const;

// 만 19세 미만인지(한국 날짜 기준). 19번째 생일 당일부터 성인이다.
export function isMinor(birthDate: Date, now: Date): boolean {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const cutoff = Date.UTC(kst.getUTCFullYear() - 19, kst.getUTCMonth(), kst.getUTCDate());
  return birthDate.getTime() > cutoff;
}

// 쇼핑몰이 미성년자 구매를 막는지
export async function minorPurchaseBlocked(db: Db, sellerId: string): Promise<boolean> {
  const row = await db.shopLegalNotice.findUnique({ where: { sellerId }, select: { minorPolicy: true } });
  return row?.minorPolicy === "BLOCK";
}

// 정책을 이미 읽은 값(blocking)으로 판정한다. 같은 응답에서 정책과 결과가 어긋나지 않게 한 번만 읽고 이 함수로 낸다.
export function minorPurchaseDecision(blocking: boolean, member: { birthDate: Date | null }, now: Date): MinorPurchaseBlock | null {
  if (!blocking) return null;
  if (!member.birthDate) return "identity_reverify_required";
  return isMinor(member.birthDate, now) ? "minor_blocked" : null;
}

// 이 회원이 지금 구매할 수 없으면 사유, 아니면 null (쓰기 없음)
export async function minorPurchaseCheck(db: Db, sellerId: string, member: { birthDate: Date | null }, now: Date): Promise<MinorPurchaseBlock | null> {
  return minorPurchaseDecision(await minorPurchaseBlocked(db, sellerId), member, now);
}
