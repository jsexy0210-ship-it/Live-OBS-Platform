import type { PrismaClient } from "@prisma/client";
import { platformMailInfo } from "../admin/platformBusinessInfo";
import { mailSender } from "../mail/registry";
import { sendMail, type MailSender } from "../mail/quota";
import { partnerApprovedMail, partnerRejectedMail } from "../mail/templates";

// 파트너스 가입 승인·반려 안내 메일 발송(디자인 EM-101·102, 정기 작업 seller_application.send_decision_mails).
// - 승인: ACTIVE이고 승인한 지 30초가 지난 쇼핑몰(승인 되돌리기 10초가 지난 뒤, sellers/applications.ts undoApproval). 자동 승인(신청 때 바로 승인)도 같다.
//   체험이 있는 플랜(trialEndsAt 있음)은 체험 안내, 쇼핑몰 통합(체험 없음)은 구독 결제 안내(런칭 할인가·정가는 플랜의 salePrice·listPrice).
// - 반려: REJECTED(마스터 반려·보완 기한 지난 자동 반려). 사유는 반려 때 적은 문구 그대로. 다시 신청 버튼은 가입 화면, 신청 상태는 대기 화면.
// - 최근 7일 안에 결정된 건만 보고, 같은 종류·쇼핑몰은 한 번만 보낸다(발송 기록 kind+refId로 확인, 쇼핑몰·종류별 잠금으로 동시 실행도 한 번).
//   공급자 없음·APP_ORIGIN 없음(링크를 만들 수 없음)이면 아무것도 보내지 않고 기록하지 않는다(나중에 채워지면 7일 안에 따라 보낸다).
//   플랫폼 사업자 정보가 비어 있으면 바닥글에서 그 항목만 빼고 보낸다(MASTER 결정, 값을 지어내지 않음).
//   제공량·한도에 걸려 못 보내거나 실패한 건은 기록이 남아 다시 보내지 않는다(플랫폼 부담 메일, sellerId 없음).
// - 수신자는 대표자 계정 이메일(없으면 건너뜀). 메일 주소·사유는 로그에 남기지 않는다.
export const APPROVE_DELAY_MS = 30_000;
export const LOOKBACK_MS = 7 * 86_400_000;
const BATCH = 50;
const KINDS = { approved: "application.approved", rejected: "application.rejected" } as const;

export async function sendDecisionMails(db: PrismaClient, now: Date, opts: { sender?: MailSender | null } = {}): Promise<number> {
  const sender = opts.sender === undefined ? mailSender() : opts.sender;
  if (!sender) return 0;
  const platform = await platformMailInfo(db);
  const origin = process.env.APP_ORIGIN?.replace(/\/+$/, "");
  if (!platform || !origin) return 0;
  const since = new Date(now.getTime() - LOOKBACK_MS);

  const [approved, rejected] = await Promise.all([
    db.seller.findMany({
      where: { status: "ACTIVE", approvedAt: { gte: since, lte: new Date(now.getTime() - APPROVE_DELAY_MS) } },
      orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
      take: BATCH * 2,
      select: { id: true, slug: true, shopName: true, businessInfo: true, trialEndsAt: true, plan: { select: { trialDays: true, listPrice: true, salePrice: true } } },
    }),
    db.seller.findMany({
      where: { status: "REJECTED", rejectedAt: { gte: since, lte: now } },
      orderBy: [{ rejectedAt: "asc" }, { id: "asc" }],
      take: BATCH * 2,
      select: { id: true, shopName: true, businessInfo: true, rejectedReason: true },
    }),
  ]);
  const ids = [...approved, ...rejected].map((s) => s.id);
  if (ids.length === 0) return 0;
  const [done, owners] = await Promise.all([
    db.mailDelivery.findMany({ where: { kind: { in: [KINDS.approved, KINDS.rejected] }, refId: { in: ids } }, select: { kind: true, refId: true } }),
    db.sellerUser.findMany({ where: { sellerId: { in: ids }, isOwner: true }, select: { sellerId: true, email: true } }),
  ]);
  const sent = new Set(done.map((d) => `${d.kind}:${d.refId}`));
  const owner = new Map(owners.map((o) => [o.sellerId, o.email]));
  const rep = (info: unknown) => {
    const n = info && typeof info === "object" ? (info as Record<string, unknown>).representativeName : null;
    return typeof n === "string" && n.trim() ? n.trim() : "대표자";
  };

  let n = 0;
  const deliver = async (sellerId: string, kind: string, build: (to: string) => { subject: string; text: string; html: string }) => {
    const to = owner.get(sellerId);
    if (!to || sent.has(`${kind}:${sellerId}`)) return;
    await db.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('decision_mail'), hashtext(${`${kind}:${sellerId}`})) AS "locked"`;
        if (!locked) return;
        if (await tx.mailDelivery.findFirst({ where: { kind, refId: sellerId }, select: { id: true } })) return;
        const r = await sendMail(db, sender, { sellerId: null, kind, refId: sellerId, message: { to, ...build(to) } });
        if (r.status === "SENT") n++;
      },
      { timeout: 30_000 },
    );
  };

  for (const s of approved.slice(0, BATCH)) {
    const plan = s.plan;
    await deliver(s.id, KINDS.approved, () =>
      partnerApprovedMail({
        platform,
        representative: rep(s.businessInfo),
        shopName: s.shopName,
        shopUrl: `${platform.url}/shop/${s.slug}`,
        adminUrl: `${origin}/seller/login`,
        loginEmail: owner.get(s.id) ?? "",
        ...(s.trialEndsAt ? { plan: "TRIAL" as const, trialDays: plan?.trialDays ?? 7, trialEndsAt: s.trialEndsAt } : { plan: "INTEGRATED" as const, launchMonthly: plan?.salePrice ?? 0, regularMonthly: plan?.listPrice ?? 0 }),
      }),
    );
  }
  for (const s of rejected.slice(0, BATCH)) {
    await deliver(s.id, KINDS.rejected, () =>
      partnerRejectedMail({ platform, representative: rep(s.businessInfo), shopName: s.shopName, statusUrl: `${origin}/seller/pending`, kind: "REJECTED", reason: s.rejectedReason ?? "가입 조건을 확인할 수 없었어요", reapplyUrl: `${origin}/seller/signup` }),
    );
  }
  return n;
}
