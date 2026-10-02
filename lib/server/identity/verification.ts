import type { IdentityVerification, IdentityVerificationPurpose, Prisma, PrismaClient } from "@prisma/client";
import { generateToken, hashToken } from "../auth/token";
import { hashCi } from "./ciHash";
import type { IdentityProvider } from "./provider";

const REQUEST_TTL_MS = 10 * 60_000;

// 본인인증 시작. ownerToken은 시작한 브라우저에만 주는 일회용 값(HttpOnly 쿠키로 보관)이고,
// 완료할 때 같은 값이 있어야 한다. DB에는 해시만 저장한다.
export async function startIdentityVerification(
  db: PrismaClient | Prisma.TransactionClient,
  provider: IdentityProvider,
  input: { purpose: IdentityVerificationPurpose; sellerId: string | null; subjectId?: string | null; requestIp?: string | null; now?: Date },
): Promise<{ verification: IdentityVerification; ownerToken: string }> {
  const now = input.now ?? new Date();
  const { requestId } = await provider.createRequest();
  const ownerToken = generateToken();
  const verification = await db.identityVerification.create({
    data: {
      purpose: input.purpose,
      sellerId: input.sellerId,
      subjectId: input.subjectId ?? null,
      requestIp: input.requestIp ?? null,
      provider: provider.name,
      requestId,
      ownerTokenHash: hashToken(ownerToken),
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
      ...(input.now ? { createdAt: input.now } : {}),
    },
  });
  return { verification, ownerToken };
}

export type CompleteResult =
  | { ok: true; verification: IdentityVerification }
  | { ok: false; reason: "not_found" | "expired" | "failed" | "pending" };

// 공급자에서 결과를 받아 기록한다. CI는 해시로만 남긴다.
// owner: 이 인증을 시작한 쪽(쇼핑몰·용도·시작한 브라우저의 ownerToken). 하나라도 다르면 없는 것으로 처리한다.
export async function completeIdentityVerification(
  db: PrismaClient,
  provider: IdentityProvider,
  verificationId: string,
  owner: { sellerId: string | null; purpose: IdentityVerificationPurpose; ownerToken: string | undefined },
  now = new Date(),
): Promise<CompleteResult> {
  const v = await db.identityVerification.findUnique({ where: { id: verificationId } });
  if (
    !v ||
    v.provider !== provider.name ||
    v.sellerId !== owner.sellerId ||
    v.purpose !== owner.purpose ||
    !owner.ownerToken ||
    v.ownerTokenHash !== hashToken(owner.ownerToken)
  ) {
    return { ok: false, reason: "not_found" };
  }
  // 이미 완료된 건도 유효 시간이 지나면 쓰지 않는다(오래된 인증으로 나중에 권한을 받지 못하게).
  if (v.status === "VERIFIED") return v.expiresAt > now ? { ok: true, verification: v } : { ok: false, reason: "expired" };
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
