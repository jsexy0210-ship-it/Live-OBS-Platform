import type { IdentityVerification, IdentityVerificationPurpose, PrismaClient } from "@prisma/client";
import { hashCi } from "./ciHash";
import type { IdentityProvider } from "./provider";

const REQUEST_TTL_MS = 10 * 60_000;

export async function startIdentityVerification(
  db: PrismaClient,
  provider: IdentityProvider,
  input: { purpose: IdentityVerificationPurpose; sellerId: string | null; now?: Date },
): Promise<IdentityVerification> {
  const now = input.now ?? new Date();
  const { requestId } = await provider.createRequest();
  return db.identityVerification.create({
    data: {
      purpose: input.purpose,
      sellerId: input.sellerId,
      provider: provider.name,
      requestId,
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
      createdAt: now,
    },
  });
}

export type CompleteResult =
  | { ok: true; verification: IdentityVerification }
  | { ok: false; reason: "not_found" | "expired" | "failed" | "pending" };

// 공급자에서 결과를 받아 기록한다. CI는 해시로만 남긴다.
// owner: 이 인증을 요청한 쪽(쇼핑몰·용도). 다르면 없는 것으로 처리한다.
// TODO(라우트 만들 때): 인증 id를 요청한 브라우저 세션에도 묶어야 한다(다른 사람이 id를 알아내 완료·가입에 쓰지 못하게).
//   그 라우트에는 「다른 세션의 인증 id로 완료·가입 시도 → 거부」 통합 테스트를 함께 넣는다.
export async function completeIdentityVerification(
  db: PrismaClient,
  provider: IdentityProvider,
  verificationId: string,
  owner: { sellerId: string | null; purpose: IdentityVerificationPurpose },
  now = new Date(),
): Promise<CompleteResult> {
  const v = await db.identityVerification.findUnique({ where: { id: verificationId } });
  if (!v || v.provider !== provider.name || v.sellerId !== owner.sellerId || v.purpose !== owner.purpose) {
    return { ok: false, reason: "not_found" };
  }
  if (v.status === "VERIFIED") return { ok: true, verification: v };
  if (v.status !== "PENDING") return { ok: false, reason: v.status === "EXPIRED" ? "expired" : "failed" };
  if (v.expiresAt <= now) {
    await db.identityVerification.update({ where: { id: v.id }, data: { status: "EXPIRED" } });
    return { ok: false, reason: "expired" };
  }
  // 운영에서는 가짜 공급자 기록을 완료 처리하지 않는다(공급자 객체를 우회해 만든 경우까지 막는다).
  if (v.provider === "fake" && process.env.NODE_ENV === "production") return { ok: false, reason: "failed" };
  const r = await provider.fetchResult(v.requestId);
  if (!r.ok) {
    if (r.reason === "failed") await db.identityVerification.update({ where: { id: v.id }, data: { status: "FAILED" } });
    return { ok: false, reason: r.reason };
  }
  const verification = await db.identityVerification.update({
    where: { id: v.id },
    data: { status: "VERIFIED", ciHash: hashCi(r.ci), name: r.name, phone: r.phone, birthDate: r.birthDate, verifiedAt: now },
  });
  return { ok: true, verification };
}
