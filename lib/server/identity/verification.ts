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
export async function completeIdentityVerification(
  db: PrismaClient,
  provider: IdentityProvider,
  verificationId: string,
  now = new Date(),
): Promise<CompleteResult> {
  const v = await db.identityVerification.findUnique({ where: { id: verificationId } });
  if (!v || v.provider !== provider.name) return { ok: false, reason: "not_found" };
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
