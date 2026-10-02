import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "./session";
import { recordAccountFailure } from "./lockout";
import { open, seal } from "./secretBox";
import { generateTotpSecret, matchTotpCounter } from "./totp";

const ISSUER = "LiveOBS";

// TOTP 등록 시작: 임시 비밀키를 만들어 암호화해 두고, 인증 앱에 넣을 주소를 돌려준다(이때만 비밀키를 보여 준다).
export async function startTotpEnrollment(db: PrismaClient, ctx: AdminSessionContext) {
  const secret = generateTotpSecret();
  await db.platformAdmin.update({ where: { id: ctx.admin.id }, data: { totpPendingSecretEnc: seal(secret) } });
  const label = encodeURIComponent(`${ISSUER}:${ctx.admin.email}`);
  return {
    secret,
    otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${ISSUER}&algorithm=SHA1&digits=6&period=30`,
  };
}

export type ConfirmResult = { ok: true } | { ok: false; reason: "not_started" | "invalid_code" | "locked" };

// TOTP 등록 확인: 인증 앱 코드가 맞으면 등록하고, 지금 세션을 2단계 인증을 마친 세션으로 올린다.
export async function confirmTotpEnrollment(
  db: PrismaClient,
  ctx: AdminSessionContext,
  code: string,
  meta: { ip?: string | null; userAgent?: string | null; now?: Date } = {},
): Promise<ConfirmResult> {
  const now = meta.now ?? new Date();
  const admin = await db.platformAdmin.findUniqueOrThrow({ where: { id: ctx.admin.id } });
  if (!admin.totpPendingSecretEnc || admin.totpEnabledAt) return { ok: false, reason: "not_started" };
  const counter = matchTotpCounter(open(admin.totpPendingSecretEnc), code, now);
  if (counter === null) {
    const locked = await recordAccountFailure(db, "PlatformAdmin", admin.id, now);
    return { ok: false, reason: locked ? "locked" : "invalid_code" };
  }
  await db.$transaction(async (tx) => {
    const done = await tx.platformAdmin.updateMany({
      where: { id: admin.id, totpEnabledAt: null, totpPendingSecretEnc: admin.totpPendingSecretEnc },
      data: { totpSecretEnc: admin.totpPendingSecretEnc, totpPendingSecretEnc: null, totpEnabledAt: now, lastTotpCounter: counter },
    });
    if (done.count !== 1) throw new Error("동시에 등록이 진행됐어요.");
    await tx.adminSession.update({ where: { id: ctx.sessionId }, data: { mfaVerifiedAt: now, enrollmentOnly: false } });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.id,
      action: "admin.mfa.enroll",
      targetType: "PlatformAdmin",
      targetId: admin.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { ok: true };
}
