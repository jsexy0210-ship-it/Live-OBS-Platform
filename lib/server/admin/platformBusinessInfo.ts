import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import type { PlatformInfo } from "../mail/templates";
import { cleanText } from "../text/clean";

// 플랫폼(ONQ) 사업자 정보(마스터 관리자 설정). 파트너스 가입 안내 메일 바닥글(EM-101·102)에 쓴다.
// 조회는 마스터 관리자 전 역할, 바꾸기는 최고관리자만(system.manage). 로그 추적에는 바뀐 칸 이름만 남긴다(값은 남기지 않음).
// 값이 비어 있으면 가입 안내 메일 바닥글에서 그 항목만 빠지고 발송은 그대로 한다(sellers/decisionMails.ts).
export const BUSINESS_NUMBER = /^\d{3}-\d{2}-\d{5}$/;
// 전자상거래법 표시 의무 7항목: 상호·대표·사업자등록번호·통신판매업 신고번호·주소·고객센터 전화·이메일
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const FIELDS = ["name", "representative", "businessNumber", "mailOrderNumber", "address", "phone", "email"] as const;
export type BusinessField = (typeof FIELDS)[number];
const MAX: Record<BusinessField, number> = { name: 60, representative: 40, businessNumber: 12, mailOrderNumber: 60, address: 200, phone: 30, email: 100 };

export type PlatformBusinessInfoRejection = "invalid_field";
export const PLATFORM_BUSINESS_MESSAGES: Record<PlatformBusinessInfoRejection, string> = { invalid_field: "입력한 값을 다시 확인해 주십시오" };

const view = (r: ({ [K in BusinessField]: string } & { updatedAt: Date }) | null) => ({
  name: r?.name ?? "",
  representative: r?.representative ?? "",
  businessNumber: r?.businessNumber ?? "",
  mailOrderNumber: r?.mailOrderNumber ?? "",
  address: r?.address ?? "",
  phone: r?.phone ?? "",
  email: r?.email ?? "",
  complete: !!r && FIELDS.every((f) => r[f].trim() !== ""),
  updatedAt: r?.updatedAt ?? null,
});

export async function readPlatformBusinessInfo(db: PrismaClient) {
  return view(await db.platformBusinessInfo.findUnique({ where: { id: 1 } }));
}

// 가입 안내 메일 바닥글용. 빈 칸은 빈 문자열로 두고(바닥글에서 그 항목을 뺀다, MASTER 결정 — 값을 지어내지 않고 발송도 막지 않음) 링크용 APP_ORIGIN이 없을 때만 null.
export async function platformMailInfo(db: PrismaClient): Promise<PlatformInfo | null> {
  const v = await readPlatformBusinessInfo(db);
  const origin = process.env.APP_ORIGIN?.replace(/\/+$/, "");
  if (!origin) return null;
  return { name: v.name, representative: v.representative, businessNumber: v.businessNumber, address: v.address, phone: v.phone, url: origin.replace(/^https?:\/\//, "") };
}

// 본문 { name?, representative?, businessNumber?, mailOrderNumber?, address?, phone?, email? }(보낸 칸만 바꾼다). 값은 비울 수 있다("").
export async function updatePlatformBusinessInfo(db: PrismaClient, admin: AdminSessionContext, raw: unknown, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  if (!adminCan(admin.admin.role, "system.manage")) throw forbidden();
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const next: Partial<Record<BusinessField, string>> = {};
  for (const f of FIELDS) {
    if (b[f] === undefined) continue;
    if (typeof b[f] !== "string") return { ok: false as const, reason: "invalid_field" as const, field: f };
    const t = b[f] === "" || (b[f] as string).trim() === "" ? "" : cleanText(b[f], MAX[f], "name");
    if (t === null || (f === "businessNumber" && t !== "" && !BUSINESS_NUMBER.test(t)) || (f === "email" && t !== "" && !EMAIL.test(t))) return { ok: false as const, reason: "invalid_field" as const, field: f };
    next[f] = t;
  }
  const changed = FIELDS.filter((f) => next[f] !== undefined);
  if (changed.length === 0) return { ok: true as const, changed: [] as BusinessField[], info: await readPlatformBusinessInfo(db) };
  const before = await db.platformBusinessInfo.findUnique({ where: { id: 1 } });
  const row = await db.platformBusinessInfo.upsert({ where: { id: 1 }, create: { id: 1, ...next, updatedByAdminId: admin.admin.id }, update: { ...next, updatedByAdminId: admin.admin.id } });
  const actuallyChanged = changed.filter((f) => (before?.[f] ?? "") !== row[f]);
  if (actuallyChanged.length > 0) {
    await writeAudit(db, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "platform.business_info.update", targetType: "PlatformBusinessInfo", targetId: "1", after: { fields: actuallyChanged }, ip: meta.ip, userAgent: meta.userAgent });
  }
  return { ok: true as const, changed: actuallyChanged, info: view(row) };
}
