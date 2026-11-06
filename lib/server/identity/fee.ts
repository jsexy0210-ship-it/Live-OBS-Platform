import type { Prisma, PrismaClient } from "@prisma/client";
import { sellerAccessFor } from "../billing/subscription";
import { captureDebit, channelPrice, releaseDebit, reserveDebit } from "../messaging/balance";
import { recordMessageShortage, resolveMessageShortages } from "../messaging/shortage";

// 구매자 가입 본인확인 건당 비용(대표님 확정 2026-10-26, docs/COST_POLICY.md): 파트너스 「발송·이용 충전금」 차감.
// - 체험하기 중에는 무료(50건 한도는 billing/trialLimits.ts가 따로 막는다).
// - 단가는 마스터 관리자가 본인확인 대행사 계약 뒤 설정하는 값이다. 단가가 0(미설정)이면 차감하지 않는다(코드에 금액을 정하지 않음).
// - 본인확인을 시작할 때 차감을 잡고(reserveDebit), 확인이 성공(VERIFIED)하면 확정하고(captureDebit), 공급자 장애로 시작하지 못하면 되돌린다.
//   그 밖에 끝나지 않은 요청의 잡아 둔 차감은 멈춘 예약 정리(messaging/holds.ts, 30분)가 되돌린다. 성공 확인이 없으면 차감하지 않는다.
// - 잔액이 없으면 가입 본인확인만 시작하지 않는다(주문 처리 등 다른 업무는 계속). 파트너스 알림 센터 「충전금」 알림으로 알린다.
type Db = PrismaClient | Prisma.TransactionClient;

const CHANNEL = "IDENTITY_VERIFICATION" as const;
export const identityFeeKey = (verificationId: string) => `identity:${verificationId}`;

// 시작 트랜잭션 안에서 부른다(요청 기록을 만들기 전). 못 잡으면 시작하지 않는다(ok:false).
export async function reserveBuyerIdentityFee(tx: Prisma.TransactionClient, sellerId: string, verificationId: string, now: Date): Promise<{ ok: boolean }> {
  if ((await sellerAccessFor(tx, sellerId, now)) === "trial") return { ok: true };
  if ((await channelPrice(tx, CHANNEL, now)) <= 0) return { ok: true };
  const key = identityFeeKey(verificationId);
  const r = await reserveDebit(tx, { sellerId, channel: CHANNEL, idempotencyKey: key, now });
  if (!r.ok) {
    await recordMessageShortage(tx, { sellerId, channel: CHANNEL, reason: r.reason === "insufficient_balance" ? "INSUFFICIENT_BALANCE" : "CHARGING_DISABLED", eventKey: key, now });
    return { ok: false };
  }
  await resolveMessageShortages(tx, { sellerId, channels: [CHANNEL], now });
  return { ok: true };
}

const heldLedgerId = async (db: Db, sellerId: string, verificationId: string) =>
  (await db.sellerMessageLedger.findFirst({ where: { sellerId, idempotencyKey: identityFeeKey(verificationId), type: "DEBIT", status: "PENDING" }, select: { id: true } }))?.id ?? null;

// 본인확인이 성공(VERIFIED)으로 확정될 때(같은 트랜잭션) 잡아 둔 차감을 확정한다. 잡은 것이 없으면(체험·단가 0) 아무것도 하지 않는다.
export async function captureBuyerIdentityFee(db: Db, sellerId: string, verificationId: string) {
  const id = await heldLedgerId(db, sellerId, verificationId);
  if (id) await captureDebit(db, id);
}

// 인증번호를 보내지 못해 요청이 실패로 끝났을 때 잡아 둔 차감을 되돌린다.
export async function releaseBuyerIdentityFee(db: PrismaClient, sellerId: string, verificationId: string) {
  const id = await heldLedgerId(db, sellerId, verificationId);
  if (id) await releaseDebit(db, id);
}
