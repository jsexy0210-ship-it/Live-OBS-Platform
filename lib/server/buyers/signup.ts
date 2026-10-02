import { Prisma, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { hashPassword } from "../auth/password";

// 본인인증 후 가입에 쓸 수 있는 시간
const SIGNUP_WINDOW_MS = 30 * 60_000;

export type BuyerSignupFailure =
  | "verification_invalid"
  | "already_member"
  | "login_id_taken"
  | "nickname_taken"
  | "shop_unavailable";

export type BuyerSignupResult = { ok: true; memberId: string } | { ok: false; reason: BuyerSignupFailure };

// 구매자 회원가입. PASS 본인인증(같은 쇼핑몰, 완료, 30분 안)이 있어야 하고,
// 같은 쇼핑몰에 같은 CI로 가입한 회원이 있으면 거부한다. 이름·휴대폰·생년월일은 인증 결과를 쓴다.
export async function signupBuyer(
  db: PrismaClient,
  input: { sellerId: string; verificationId: string; loginId: string; password: string; broadcastNickname: string; now?: Date },
): Promise<BuyerSignupResult> {
  const now = input.now ?? new Date();
  const seller = await db.seller.findUnique({ where: { id: input.sellerId }, select: { status: true } });
  if (!seller || seller.status !== "ACTIVE") return { ok: false, reason: "shop_unavailable" };

  const v = await db.identityVerification.findUnique({ where: { id: input.verificationId } });
  if (
    !v ||
    v.sellerId !== input.sellerId ||
    v.purpose !== "BUYER_SIGNUP" ||
    v.status !== "VERIFIED" ||
    !v.ciHash ||
    !v.verifiedAt ||
    !v.name ||
    !v.phone ||
    !v.birthDate ||
    now.getTime() - v.verifiedAt.getTime() > SIGNUP_WINDOW_MS
  ) {
    return { ok: false, reason: "verification_invalid" };
  }

  const existing = await db.buyerMember.findFirst({
    where: { sellerId: input.sellerId, ciHash: v.ciHash, deletedAt: null },
    select: { id: true },
  });
  if (existing) return { ok: false, reason: "already_member" };

  const grade = await db.memberGrade.findFirst({
    where: { sellerId: input.sellerId },
    orderBy: [{ sortOrder: "asc" }],
    select: { id: true },
  });
  if (!grade) return { ok: false, reason: "shop_unavailable" };

  try {
    const member = await db.buyerMember.create({
      data: {
        sellerId: input.sellerId,
        loginId: input.loginId.trim(),
        passwordHash: await hashPassword(input.password),
        name: v.name,
        phone: v.phone,
        ciHash: v.ciHash,
        identityVerifiedAt: v.verifiedAt,
        birthDate: v.birthDate,
        broadcastNickname: input.broadcastNickname.trim(),
        gradeId: grade.id,
        createdAt: now,
      },
    });
    await writeAudit(db, { actorType: "BUYER", actorId: member.id, sellerId: input.sellerId, action: "buyer.signup" });
    return { ok: true, memberId: member.id };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // 부분 유니크 인덱스 이름으로 어느 값이 겹쳤는지 구분한다(동시에 가입한 경우 포함).
      const target = String((e.meta as { target?: unknown } | undefined)?.target ?? e.message);
      if (target.includes("ciHash") || target.includes("phone")) return { ok: false, reason: "already_member" };
      if (target.includes("loginId")) return { ok: false, reason: "login_id_taken" };
      if (target.includes("broadcastNickname")) return { ok: false, reason: "nickname_taken" };
    }
    throw e;
  }
}
