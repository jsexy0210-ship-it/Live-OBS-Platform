import type { PrismaClient } from "@prisma/client";
import { platformMailInfo } from "../admin/platformBusinessInfo";
import { mailSender } from "../mail/registry";
import { sendMail, type MailSender } from "../mail/quota";
import { priceChangeMail } from "../mail/templates";
import { REQUIRED_PRICE_NOTICE_CHANNELS, priceNoticeCompletedAt } from "./priceNotice";
import { chargeFor, dbNow } from "./subscription";

// 구독 요금 변경 고지 발송 작업(PRODUCT_SCOPE 「가격 변경 안내」, 대표님 승인 2026-10-16). 수동 실행만(자동 스케줄 없음).
// 플랜마다 마스터가 올린 가장 최근 요금 변경(changedByAdminId 있음) 전에 구독을 시작해 아직 구독 중인 파트너스에게
//   · 메일(MAIL): 대표자 이메일 1통 — 발송 기록(MailDelivery kind price_change.notice, refId 구독:변경)으로 이미 보냈는지 확인해 한 번만
//   · 파트너스 공지(PARTNERS_NOTICE): 변경마다 플랫폼 공지 1건(대상 파트너스)을 만들고 모든 구독의 수령 기록이 그 공지를 가리킨다
// 를 보내고 SubscriptionPriceNotice 수령 기록(SENT·completedAt·deliveryReference)을 남긴다. 두 채널이 모두 SENT여야 고지 완료이고(priceNotice.ts),
// 그 시각부터 30일 뒤 결제부터 chargeFor가 새 요금을 쓴다. 알림톡은 연결된 발송 경로가 없어 이 작업에서 만들지 않는다.
// 안전: 공급자(메일 전송기)가 없으면 메일은 보내지도 기록하지도 않는다(운영에서 공급자 연결 전). 테스트·개발은 가짜 전송기만 쓴다.
//   메일 비용은 기본 「마스터 관리자 부담」(sellerId 없는 플랫폼 메일 = 가입 승인 안내와 같음): 파트너스 잔액이 없다고 법정 고지가 막혀 요금 인상이
//   영영 적용되지 않거나, 파트너스 충전금이 이 고지로 줄어들지 않게 한다. 파트너스 제공량·충전금 정책으로 보내려면 bearer: "seller"(수동).
export const PRICE_NOTICE_MAIL_KIND = "price_change.notice";

export type PriceNoticeSendResult = { considered: number; mailSent: number; mailBlocked: number; noticeCreated: number; completed: number };

export async function sendPriceChangeNotices(
  db: PrismaClient,
  opts: { now?: Date; sender?: MailSender | null; planCode?: string; bearer?: "platform" | "seller"; limit?: number } = {},
): Promise<PriceNoticeSendResult> {
  const result: PriceNoticeSendResult = { considered: 0, mailSent: 0, mailBlocked: 0, noticeCreated: 0, completed: 0 };
  const sender = opts.sender === undefined ? mailSender() : opts.sender;
  const platform = await platformMailInfo(db);
  const origin = process.env.APP_ORIGIN?.replace(/\/+$/, "");
  const now = opts.now ?? (await dbNow(db));
  const plans = await db.subscriptionPlan.findMany({ where: opts.planCode ? { code: opts.planCode } : {}, orderBy: { code: "asc" } });
  for (const plan of plans) {
    const change = await db.subscriptionPriceChange.findFirst({ where: { planId: plan.id, changedByAdminId: { not: null } }, orderBy: { changedAt: "desc" } });
    if (!change || !change.changedByAdminId) continue;
    const subs = await db.sellerSubscription.findMany({
      where: { planId: plan.id, status: { in: ["ACTIVE", "PAST_DUE"] }, cancelAtPeriodEnd: false, subscribedAt: { lt: change.changedAt } },
      orderBy: [{ subscribedAt: "asc" }, { id: "asc" }],
      take: opts.limit ?? 200,
      select: {
        id: true, sellerId: true, subscribedAt: true, legacyPrice: true, legacyPriceNoticeSentAt: true, regularPrice: true,
        priceNotices: { where: { priceChangeId: change.id } },
        seller: { select: { shopName: true, businessInfo: true, users: { where: { isOwner: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1, select: { email: true } } } },
      },
    });
    for (const sub of subs) {
      result.considered += 1;
      const receipts = sub.priceNotices.filter((r) => +r.subscriptionStartedAt === +sub.subscribedAt);
      const sent = (channel: (typeof REQUIRED_PRICE_NOTICE_CHANNELS)[number]) => receipts.some((r) => r.channel === channel && r.status === "SENT" && r.deliveryReference && r.completedAt);
      const key = { subscriptionId: sub.id, subscriptionStartedAt: sub.subscribedAt, priceChangeId: change.id };

      // 파트너스 공지: 변경마다 공지 1건. 잠금 아래에서 이미 만든 공지를 찾고 없을 때만 만든다(동시에 돌려도 한 건).
      if (!sent("PARTNERS_NOTICE")) {
        const created = await db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`price_notice:${change.id}`}))`;
          const existing = await tx.subscriptionPriceNotice.findFirst({
            where: { priceChangeId: change.id, channel: "PARTNERS_NOTICE", status: "SENT", deliveryReference: { startsWith: "notice:" } },
            select: { deliveryReference: true },
          });
          let noticeId = existing?.deliveryReference?.slice("notice:".length) ?? null;
          let made = false;
          if (!noticeId) {
            const notice = await tx.platformNotice.create({
              data: {
                title: `${plan.name} 구독 요금 변경 안내`,
                body: `${plan.name} 구독 요금이 바뀝니다. 정가 월 ${plan.listPrice.toLocaleString("ko-KR")}원, 런칭 할인가 월 ${plan.salePrice.toLocaleString("ko-KR")}원(부가세 포함)입니다. 이미 구독 중인 파트너스에는 이 안내를 받은 날부터 30일이 지난 뒤 결제부터 적용되고, 그 전 결제는 지금 요금 그대로입니다. 적용 전 해지는 「구독 · 결제」에서 할 수 있습니다.`,
                category: "POLICY",
                audience: "PARTNERS",
                publishedAt: now,
                createdByAdminId: change.changedByAdminId!,
                updatedByAdminId: change.changedByAdminId!,
              },
            });
            noticeId = notice.id;
            made = true;
          }
          await tx.subscriptionPriceNotice.upsert({
            where: { subscriptionId_subscriptionStartedAt_priceChangeId_channel: { ...key, channel: "PARTNERS_NOTICE" } },
            create: { ...key, channel: "PARTNERS_NOTICE", status: "SENT", completedAt: now, deliveryReference: `notice:${noticeId}` },
            update: { status: "SENT", completedAt: now, deliveryReference: `notice:${noticeId}` },
          });
          return made;
        });
        if (created) result.noticeCreated += 1;
      }

      // 메일: 공급자·플랫폼 정보·APP_ORIGIN이 없으면 보내지도 기록하지도 않는다.
      if (!sent("MAIL") && sender && platform && origin) {
        const to = sub.seller.users[0]?.email;
        const refId = `${sub.id}:${change.id}`;
        if (to) {
          const done = await db.mailDelivery.findFirst({ where: { kind: PRICE_NOTICE_MAIL_KIND, refId, status: "SENT" }, select: { id: true } });
          const inFlight = done ? null : await db.mailDelivery.findFirst({ where: { kind: PRICE_NOTICE_MAIL_KIND, refId, status: "PENDING" }, select: { id: true } });
          let deliveryId = done?.id ?? null;
          if (!done && !inFlight) {
            const oldMonthly = (await chargeFor(db, plan, sub, now)).amount;
            const rep = sub.seller.businessInfo && typeof sub.seller.businessInfo === "object" ? (sub.seller.businessInfo as Record<string, unknown>).representativeName : null;
            const body = priceChangeMail({
              platform,
              representative: typeof rep === "string" && rep.trim() ? rep.trim() : "대표자",
              shopName: sub.seller.shopName,
              planName: plan.name,
              oldMonthly,
              newMonthly: sub.regularPrice ? change.listPrice : change.salePrice,
              subscriptionUrl: `${origin}/seller/subscription`,
            });
            const r = await sendMail(db, sender, {
              sellerId: opts.bearer === "seller" ? sub.sellerId : null,
              kind: PRICE_NOTICE_MAIL_KIND,
              refId,
              message: { to, subject: body.subject, html: body.html, text: body.text },
            });
            if (r.status === "SENT") deliveryId = r.deliveryId;
            else result.mailBlocked += 1;
          }
          if (deliveryId) {
            await db.subscriptionPriceNotice.upsert({
              where: { subscriptionId_subscriptionStartedAt_priceChangeId_channel: { ...key, channel: "MAIL" } },
              create: { ...key, channel: "MAIL", status: "SENT", completedAt: now, deliveryReference: `mail:${deliveryId}` },
              update: { status: "SENT", completedAt: now, deliveryReference: `mail:${deliveryId}` },
            });
            if (!done) result.mailSent += 1;
          }
        }
      }

      const after = await db.subscriptionPriceNotice.findMany({ where: { ...key } });
      if (priceNoticeCompletedAt(change.changedAt, after, new Date(now.getTime() + 1))) result.completed += 1;
    }
  }
  return result;
}
