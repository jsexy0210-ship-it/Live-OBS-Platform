import type { PrismaClient } from "@prisma/client";
import { platformMailInfo } from "../admin/platformBusinessInfo";
import { mailSender } from "../mail/registry";
import { sendMail, type MailSender } from "../mail/quota";
import { retentionNoticeMail } from "../mail/templates";
import { dbNow } from "./subscription";

// 삭제 전 안내 메일 작업(PRODUCT_SCOPE 「해지·삭제 전에 파트너스에게 미리 알린다」, 대표님 승인 2026-10-16). 수동 실행만(자동 스케줄 없음).
// 해지(serviceEndedAt) 뒤 보관 기간이 끝나기 전 안내 기간 안에 있는 파트너스의 대표자 이메일로 1통을 보낸다. 같은 해지(serviceEndedAt)에는 한 번만(다시 구독했다 해지하면 새 해지로 본다).
// 비용: 거래성 안내 메일이라 「마스터 관리자 부담」(sellerId 없는 플랫폼 메일). 파트너스 월 제공량·발송·이용 충전금에 영향이 없다(요금 변경 고지와 같은 원칙).
// 실제 삭제는 하지 않는다. 삭제 실행 스위치(RETENTION_DELETION_ENABLED)는 기본 꺼짐이고, 켜도 이 모듈은 보고만 한다(삭제 코드 없음, executed 항상 0).
export const RETENTION_NOTICE_MAIL_KIND = "retention.notice";
export const RETENTION_DAYS = 90; // lifecycleDryRun retention.sourceDays와 같은 원본 기준(정책 enum 적용 전)
// 임시값: 삭제 며칠 전에 알릴지는 PRODUCT_SCOPE에 정해져 있지 않다. 대표님이 정하면 이 한 줄만 바꾼다.
export const RETENTION_NOTICE_LEAD_DAYS = 14;
const DAY = 86_400_000;
const CLAIM_STALE_MS = 10 * 60_000;
const KST_MS = 9 * 3_600_000;

export const retentionDeletionEnabled = (env: Record<string, string | undefined> = process.env) => env.RETENTION_DELETION_ENABLED === "true";
const kstDate = (d: Date) => new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);

export type RetentionNoticeResult = { considered: number; mailSent: number; mailBlocked: number; alreadySent: number };

export async function sendRetentionNotices(db: PrismaClient, opts: { now?: Date; sender?: MailSender | null; limit?: number } = {}): Promise<RetentionNoticeResult> {
  const result: RetentionNoticeResult = { considered: 0, mailSent: 0, mailBlocked: 0, alreadySent: 0 };
  const sender = opts.sender === undefined ? mailSender() : opts.sender;
  const platform = await platformMailInfo(db);
  const origin = process.env.APP_ORIGIN?.replace(/\/+$/, "");
  if (!sender || !platform || !origin) return result; // 공급자 연결 전: 보내지도 기록하지도 않는다
  const now = opts.now ?? (await dbNow(db));
  // 보관 종료(해지+90일)가 안내 기간 안: 해지 시각이 (now-90일, now-90일+14일] 구간
  const from = new Date(now.getTime() - RETENTION_DAYS * DAY);
  const to = new Date(from.getTime() + RETENTION_NOTICE_LEAD_DAYS * DAY);
  const batch = opts.limit ?? 200;
  const loadSellers = (afterId: string | null) =>
    db.seller.findMany({
      where: { serviceEndedAt: { gt: from, lte: to }, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: "asc" },
      take: batch,
      select: { id: true, shopName: true, businessInfo: true, serviceEndedAt: true, users: { where: { isOwner: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1, select: { email: true } } },
    });
  let lastId: string | null = null;
  for (;;) {
    const sellers = await loadSellers(lastId);
    if (sellers.length === 0) break;
    lastId = sellers[sellers.length - 1]!.id;
    for (const s of sellers) {
      const email = s.users[0]?.email;
      if (!s.serviceEndedAt || !email) continue;
      result.considered += 1;
      const refId = `${s.id}:${s.serviceEndedAt.toISOString()}`;
      const rep = s.businessInfo && typeof s.businessInfo === "object" ? (s.businessInfo as Record<string, unknown>).representativeName : null;
      // 같은 해지에 동시에 두 번 실행돼도 한 통만 나가도록 해지 건마다 잠금 아래에서 확인하고 보낸다(보내는 중인 건·최근 멈춘 건은 다시 보내지 않는다).
      await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"retention_notice:" + refId}))`;
          const prior = await tx.mailDelivery.findFirst({ where: { kind: RETENTION_NOTICE_MAIL_KIND, refId, OR: [{ status: "SENT" }, { status: "PENDING", createdAt: { gt: new Date(now.getTime() - CLAIM_STALE_MS) } }] }, select: { status: true } });
          if (prior) {
            if (prior.status === "SENT") result.alreadySent += 1;
            return;
          }
          const body = retentionNoticeMail({
            platform,
            representative: typeof rep === "string" && rep.trim() ? rep.trim() : "대표자",
            shopName: s.shopName,
            deleteOn: kstDate(new Date(s.serviceEndedAt!.getTime() + RETENTION_DAYS * DAY)),
            subscriptionUrl: `${origin}/seller/subscription`,
          });
          const r = await sendMail(db, sender, { sellerId: null, kind: RETENTION_NOTICE_MAIL_KIND, refId, message: { to: email, subject: body.subject, html: body.html, text: body.text } });
          if (r.status === "SENT") result.mailSent += 1;
          else result.mailBlocked += 1;
        },
        { timeout: 30_000 },
      );
    }
    if (sellers.length < batch) break;
  }
  return result;
}

export type RetentionDeletionReport = {
  mode: "DRY_RUN";
  deletionEnabled: boolean;
  executed: 0;
  at: string;
  candidates: { sellerId: string; serviceEndedAt: string; retentionEndsAt: string; noticeSent: boolean }[];
};

// 보관 기간이 끝난 쇼핑몰 목록(삭제 후보)과 안내 메일 발송 여부. 읽기 전용 — 삭제는 하지 않는다.
export async function retentionDeletionReport(db: PrismaClient, opts: { now?: Date; limit?: number } = {}): Promise<RetentionDeletionReport> {
  const now = opts.now ?? (await dbNow(db));
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
  const sellers = await db.seller.findMany({ where: { serviceEndedAt: { lte: cutoff } }, orderBy: { serviceEndedAt: "asc" }, take: opts.limit ?? 500, select: { id: true, serviceEndedAt: true } });
  const sent = await db.mailDelivery.findMany({
    where: { kind: RETENTION_NOTICE_MAIL_KIND, status: "SENT", refId: { in: sellers.map((s) => `${s.id}:${s.serviceEndedAt!.toISOString()}`) } },
    select: { refId: true },
  });
  const sentRefs = new Set(sent.map((m) => m.refId));
  return {
    mode: "DRY_RUN",
    deletionEnabled: retentionDeletionEnabled(),
    executed: 0,
    at: now.toISOString(),
    candidates: sellers.map((s) => ({ sellerId: s.id, serviceEndedAt: s.serviceEndedAt!.toISOString(), retentionEndsAt: new Date(s.serviceEndedAt!.getTime() + RETENTION_DAYS * DAY).toISOString(), noticeSent: sentRefs.has(`${s.id}:${s.serviceEndedAt!.toISOString()}`) })),
  };
}
