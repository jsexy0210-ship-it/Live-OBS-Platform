import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { FIELDS, readPlatformBusinessInfo, type BusinessField } from "./platformBusinessInfo";

// 마스터 관리자 「오늘 처리할 일」 집계(MA-001, platform.read, 조회만). 숫자와 처리 화면 주소만 주고 개인정보는 넣지 않는다.
// 항목마다 { key, count, href }. href는 해당 목록 화면을 처리할 건만 걸러 연 주소다(화면 문구는 화면에서 붙인다).
// - signupPending: 승인 대기 파트너스(Seller PENDING)
// - paymentFailed: 최근 7일 안에 청구해 실패한 구독료 결제(재시도가 며칠 걸려 오늘 것만 보지 않는다)
// - refundRequested: 마스터 관리자가 처리할 구독 환불 요청(REQUESTED)
// - inquiryOpen: 답변을 기다리는 파트너스 문의(OPEN)
// - pgError: 결제대행사 오류가 있는 파트너스 수(최근 24시간 결제 실패 또는 취소 실패가 남은 곳)
// - automationFailed: 실패했거나 정리가 필요한 자동 연결 작업(FAILED·CLEANUP_NEEDED)
// - incidentCritical: 열려 있는 심각(critical) 장애(수집기 사건)
// - platformInfoMissing: 플랫폼 사업자 정보(MA-088)에서 비어 있는 표시 의무 항목 수(없으면 0, 이 항목만 fields에 빈 항목 키를 함께 준다). 읽기 전용 역할에도 보인다.
export const TASK_KEYS = ["signupPending", "paymentFailed", "refundRequested", "inquiryOpen", "pgError", "automationFailed", "incidentCritical", "platformInfoMissing"] as const;
export type TodayTaskKey = (typeof TASK_KEYS)[number];

const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
export const PAYMENT_FAILED_DAYS = 7;
const kstDate = (d: Date) => new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);

export async function adminTodayTasks(db: PrismaClient, admin: AdminSessionContext, opts: { now?: Date } = {}) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  const now = opts.now ?? (await dbNow(db));
  const since24h = new Date(now.getTime() - DAY_MS);
  const sinceFailed = new Date(now.getTime() - PAYMENT_FAILED_DAYS * DAY_MS);
  const [signupPending, paymentFailed, refundRequested, inquiryOpen, pg, automationFailed, incidents, platformInfo] = await Promise.all([
    db.seller.count({ where: { status: "PENDING" } }),
    db.subscriptionPayment.count({ where: { status: "FAILED", createdAt: { gte: sinceFailed, lte: now } } }),
    db.subscriptionRefund.count({ where: { status: "REQUESTED" } }),
    db.platformInquiry.count({ where: { status: "OPEN" } }),
    db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS "n" FROM (
        SELECT "sellerId" FROM "Payment" WHERE "status" = 'FAILED' AND "updatedAt" > ${since24h}
        UNION
        SELECT "sellerId" FROM "PaymentCancel" WHERE "status" = 'FAILED'
      ) x`,
    db.automationJob.count({ where: { status: { in: ["FAILED", "CLEANUP_NEEDED"] } } }),
    db.$queryRaw<{ severity: string; kind: string }[]>`
      SELECT DISTINCT ON ("source", "key") "severity", "kind"
      FROM "OpsEvent" WHERE "kind" IN ('incident_open', 'incident_close')
      ORDER BY "source", "key", "seq" DESC`,
    readPlatformBusinessInfo(db),
  ]);
  const incidentCritical = incidents.filter((e) => e.kind === "incident_open" && e.severity === "critical").length;
  const from = kstDate(sinceFailed);
  const to = kstDate(now);
  const missing = FIELDS.filter((f) => platformInfo[f].trim() === "");
  const items: { key: TodayTaskKey; count: number; href: string; fields?: BusinessField[] }[] = [
    { key: "signupPending", count: signupPending, href: "/admin/partners?status=PENDING" },
    { key: "paymentFailed", count: paymentFailed, href: `/admin/billing/invoices?status=FAILED&from=${from}&to=${to}` },
    { key: "refundRequested", count: refundRequested, href: "/admin/billing/refunds?status=REQUESTED" },
    { key: "inquiryOpen", count: inquiryOpen, href: "/admin/support/inquiries?status=OPEN" },
    { key: "pgError", count: pg[0]?.n ?? 0, href: "/admin/settlement/pg" },
    { key: "automationFailed", count: automationFailed, href: "/admin/ops/automation?filter=failed" },
    { key: "incidentCritical", count: incidentCritical, href: "/admin/ops/monitor" },
    { key: "platformInfoMissing", count: missing.length, href: "/admin/settings/platform-business", fields: missing },
  ];
  return { at: now, total: items.reduce((a, i) => a + i.count, 0), items };
}
