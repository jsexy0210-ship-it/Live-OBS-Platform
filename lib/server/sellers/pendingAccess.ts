import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { policyValue } from "../admin/platformPolicy";
import { writeAudit } from "../audit/log";
import { licenseSummaryOf, putSellerLicense, type LicenseFailure, type LicenseSummary } from "./businessLicense";

// 승인 대기·반려 신청자의 안내 화면(AU-005 후속)과 보완 재제출. 승인 전에는 로그인할 수 없어 세션이 없으므로, 로그인 시도에서
// 비밀번호가 맞고 신청이 승인 대기(PENDING)이거나 반려(REJECTED)이면 15분짜리 「신청 확인」 쿠키(lo_spend)를 준다.
// 쿠키 값은 서버 비밀키(IDENTITY_HASH_KEY)로 만든 HMAC 토큰(대표자 계정·자격 버전·만료)이라 DB 행이 없고, 비밀번호가 바뀌면(자격 버전) 쓸 수 없다.
// 이 쿠키로는 자기 신청의 상태 보기와 사업자등록증 다시 올리기만 된다(파트너스 세션이 아니다).
export const PENDING_ACCESS_COOKIE = "lo_spend";
export const PENDING_ACCESS_PATH = "/api/seller/pending-application";
export const PENDING_ACCESS_TTL_MS = 15 * 60_000;

export type PendingGrant = { userId: string; credentialVersion: number; application: "pending" | "rejected" };

function key(): string {
  const k = process.env.IDENTITY_HASH_KEY;
  if (!k || k.length < 32) throw new Error("IDENTITY_HASH_KEY가 없거나 너무 짧아요(32자 이상).");
  return k;
}
const sign = (body: string) => createHmac("sha256", key()).update(`seller_pending_access\0${body}`).digest("base64url");

export function issuePendingToken(g: PendingGrant, now = new Date()): { token: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + PENDING_ACCESS_TTL_MS);
  const body = `${g.userId}.${g.credentialVersion}.${expiresAt.getTime()}`;
  return { token: `${body}.${sign(body)}`, expiresAt };
}

export type PendingContext = { userId: string; sellerId: string; status: "PENDING" | "REJECTED" };

// 토큰 확인: 서명·만료·대표자 계정·자격 버전·신청 상태(PENDING·REJECTED)를 모두 맞춰 본다. 틀리면 null
export async function resolvePendingToken(db: PrismaClient, token: string | undefined, now = new Date()): Promise<PendingContext | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, ver, exp, sig] = parts;
  const expect = sign(`${userId}.${ver}.${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!(Number(exp) > now.getTime())) return null;
  const u = await db.sellerUser.findUnique({ where: { id: userId }, select: { id: true, sellerId: true, isOwner: true, status: true, credentialVersion: true, seller: { select: { status: true } } } });
  if (!u || !u.isOwner || u.status !== "ACTIVE" || u.credentialVersion !== Number(ver)) return null;
  if (u.seller.status !== "PENDING" && u.seller.status !== "REJECTED") return null;
  return { userId: u.id, sellerId: u.sellerId, status: u.seller.status };
}

export type PendingView = {
  state: "PENDING" | "SUPPLEMENT" | "REJECTED";
  // 승인 대기가 목표 시간(마스터 설정, 기본 48시간)을 넘김
  delayed: boolean;
  receivedAt: string;
  supplement: { reason: string | null; dueAt: string | null; daysLeft: number | null } | null;
  rejectedReason: string | null;
  license: LicenseSummary | null;
};

const DAY_MS = 86_400_000;

export async function pendingApplicationView(db: PrismaClient, ctx: PendingContext, now = new Date()): Promise<PendingView> {
  const seller = await db.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { createdAt: true, rejectedReason: true } });
  const rev = await db.sellerApplicationReview.findUnique({ where: { sellerId: ctx.sellerId } });
  const open = ctx.status === "PENDING" && !!rev?.supplementRequestedAt && !rev.supplementResolvedAt;
  const target = await policyValue(db, "reviewTargetHours");
  const state: PendingView["state"] = ctx.status === "REJECTED" ? "REJECTED" : open ? "SUPPLEMENT" : "PENDING";
  return {
    state,
    delayed: state === "PENDING" && now.getTime() - seller.createdAt.getTime() > target * 3_600_000,
    receivedAt: seller.createdAt.toISOString(),
    supplement:
      open && rev
        ? {
            reason: rev.supplementReason,
            dueAt: rev.supplementDueAt?.toISOString() ?? null,
            daysLeft: rev.supplementDueAt ? Math.max(0, Math.ceil((rev.supplementDueAt.getTime() - now.getTime()) / DAY_MS)) : null,
          }
        : null,
    rejectedReason: state === "REJECTED" ? seller.rejectedReason : null,
    license: await licenseSummaryOf(db, ctx.sellerId),
  };
}

// 파트너스 화면 말투(합니다체)
export const PENDING_LICENSE_MESSAGES: Record<LicenseFailure | "not_pending", string> = {
  file_empty: "파일이 비어 있습니다. 다른 파일을 올려 주십시오",
  file_too_large: "10MB 이하 파일만 올릴 수 있습니다",
  file_type_invalid: "JPG · PNG · PDF 파일만 올릴 수 있습니다",
  not_pending: "지금은 사업자등록증을 올릴 수 없습니다",
};

// 보완 요청에 답해 사업자등록증을 다시 올린다. 승인 대기 신청만. 올리면 열려 있던 보완 요청을 「제출 완료」로 닫고(마스터 목록은 확인 필요/이상 없음으로 돌아감) 로그 추적에 남긴다.
export async function resubmitLicense(db: PrismaClient, ctx: PendingContext, bytes: Buffer, rawName: string | null, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  if (ctx.status !== "PENDING") return { ok: false as const, reason: "not_pending" as const };
  const r = await putSellerLicense(db, ctx.sellerId, bytes, rawName);
  if (!r.ok) return r;
  const now = new Date();
  const closed = await db.sellerApplicationReview.updateMany({ where: { sellerId: ctx.sellerId, supplementRequestedAt: { not: null }, supplementResolvedAt: null }, data: { supplementResolvedAt: now } });
  await writeAudit(db, { actorType: "SELLER_USER", actorId: ctx.userId, sellerId: ctx.sellerId, action: "seller.signup.license_resubmitted", targetType: "Seller", targetId: ctx.sellerId, after: { fileName: r.license.fileName, supplementClosed: closed.count > 0 }, ...meta });
  return { ok: true as const, license: r.license, supplementClosed: closed.count > 0 };
}
