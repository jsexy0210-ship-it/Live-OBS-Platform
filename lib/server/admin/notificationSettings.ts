import type { AdminAlertSeverity, AdminNotifyChannel, PlatformAdminRole, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { mailSender } from "../mail/registry";
import { cleanText } from "../text/clean";

// 마스터 관리자 알림 채널 설정(MA-082): 운영팀 수신 채널 4종(슬랙·이메일·문자·외부 모니터링)과 이벤트별 라우팅 10행, 파트너스 발신 프로필 읽기.
// - 조회는 마스터 관리자 전 역할(platform.read), 바꾸기·테스트 보내기·기본값 복원은 최고관리자만(system.manage). 로그 추적에는 바뀐 항목 이름만 남기고 값은 남기지 않는다.
// - 이 설정은 저장·조회만 한다. 라우팅 표를 읽어 실제로 슬랙·문자를 보내는 발송기는 아직 없다(관리자 알림은 화면 안 알림 센터만, createAdminAlert).
// - 채널 연결 상태는 저장하지 않고 조회 때 계산한다: 실제 공급자가 있는 채널(이메일: 메일 공급자가 있고 주소가 올바를 때)만 CONNECTED, 공급자가 없는 채널(슬랙·문자·외부 모니터링)은 NOT_CONNECTED.
//   새 외부 서비스 가입·유료 연동은 만들지 않는다. 웹훅 주소·API 키·실제 전화번호 같은 비밀값은 저장하지 않고 target에는 표시용 이름만 둔다.
// - 긴급 등급 이벤트는 야간 억제를 켤 수 없다(정본 「긴급 등급은 야간 억제를 켤 수 없습니다」).
export type NotifyEventDef = { eventKey: string; label: string; severity: AdminAlertSeverity; slack: boolean; email: boolean; sms: boolean; roles: PlatformAdminRole[]; nightSuppress: boolean };
const R = (...r: PlatformAdminRole[]) => r;
export const NOTIFY_EVENTS: readonly NotifyEventDef[] = [
  { eventKey: "broadcast_payment_fail_streak", label: "방송 중 결제 승인 실패 3건 연속", severity: "URGENT", slack: true, email: true, sms: true, roles: R("OPERATIONS", "SUPER_ADMIN"), nightSuppress: false },
  { eventKey: "broadcast_overlay_reconnect_fail", label: "방송 화면 재연결 10회 실패 (방송 중)", severity: "URGENT", slack: true, email: true, sms: true, roles: R("OPERATIONS", "CS"), nightSuppress: false },
  { eventKey: "platform_outage", label: "플랫폼 장애 · 실시간 서버 다운", severity: "URGENT", slack: true, email: true, sms: true, roles: R(), nightSuppress: false },
  { eventKey: "urgent_inquiry", label: "[긴급] 분류 문의 접수", severity: "URGENT", slack: true, email: false, sms: true, roles: R("CS"), nightSuppress: false },
  { eventKey: "payment_callback_stall", label: "카드 결제 결과 알림 30분째 끊김", severity: "WARNING", slack: true, email: true, sms: false, roles: R("OPERATIONS"), nightSuppress: true },
  { eventKey: "reward_payout_failed", label: "적립금 지급 실패", severity: "WARNING", slack: true, email: false, sms: false, roles: R("OPERATIONS"), nightSuppress: true },
  { eventKey: "subscription_payment_failed", label: "구독료 결제 실패 · 연체 전환", severity: "WARNING", slack: true, email: true, sms: false, roles: R("OPERATIONS", "CS"), nightSuppress: true },
  { eventKey: "application_overdue_48h", label: "가입 신청 48시간 초과", severity: "INFO", slack: true, email: false, sms: false, roles: R("OPERATIONS"), nightSuppress: true },
  { eventKey: "live_payout_switch_on", label: "실제 지급 스위치 켜짐", severity: "INFO", slack: true, email: false, sms: false, roles: R("OPERATIONS"), nightSuppress: true },
  { eventKey: "refund_approval_request", label: "환불 승인 요청 (최고관리자)", severity: "WARNING", slack: true, email: true, sms: false, roles: R("SUPER_ADMIN"), nightSuppress: true },
];
const EVENT = new Map(NOTIFY_EVENTS.map((e) => [e.eventKey, e]));
export const CHANNELS: readonly AdminNotifyChannel[] = ["SLACK", "EMAIL", "SMS", "EXTERNAL_MONITOR"];
const SEVERITIES: readonly AdminAlertSeverity[] = ["URGENT", "WARNING", "INFO"];
const ROLES: readonly PlatformAdminRole[] = ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"];
export const TARGET_MAX = 100;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 채널 기본값(정본): 슬랙 #ops-alerts · 이메일 「긴급 · 주의」 · 문자 「긴급만 · 야간 포함」 · 외부 모니터링 없음. 저장한 값이 없는 채널은 이 값으로 보인다(주소·이름은 비움).
const CHANNEL_DEFAULT: Record<AdminNotifyChannel, { minSeverity: AdminAlertSeverity; includeNight: boolean }> = {
  SLACK: { minSeverity: "INFO", includeNight: false },
  EMAIL: { minSeverity: "WARNING", includeNight: false },
  SMS: { minSeverity: "URGENT", includeNight: true },
  EXTERNAL_MONITOR: { minSeverity: "URGENT", includeNight: true },
};

export type NotificationSettingsRejection = "invalid_body" | "invalid_channel" | "invalid_target" | "invalid_severity" | "invalid_route" | "invalid_event" | "invalid_roles" | "urgent_no_night_suppress";
export const NOTIFICATION_SETTINGS_MESSAGES: Record<NotificationSettingsRejection, string> = {
  invalid_body: "입력한 값을 다시 확인해 주십시오",
  invalid_channel: "채널을 다시 선택해 주십시오",
  invalid_target: `표시 이름·주소를 ${TARGET_MAX}자 안에서 올바르게 입력해 주십시오`,
  invalid_severity: "받을 등급을 다시 선택해 주십시오",
  invalid_route: "라우팅 설정을 다시 확인해 주십시오",
  invalid_event: "알 수 없는 이벤트입니다",
  invalid_roles: "수신 역할을 다시 선택해 주십시오",
  urgent_no_night_suppress: "긴급 등급은 야간 억제를 켤 수 없습니다",
};

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const KST = 9 * 3_600_000;

// 주소(감시)에 붙은 계정 정보·쿼리(토큰이 들어 있을 수 있음)는 저장하지 않는다
function cleanMonitorTarget(t: string): string | null {
  try {
    const u = new URL(t);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, TARGET_MAX);
  } catch {
    return null;
  }
}

type ChannelRow = { channel: AdminNotifyChannel; target: string; minSeverity: AdminAlertSeverity; includeNight: boolean; lastSentAt: Date | null; lastError: string | null };

function channelView(c: AdminNotifyChannel, row: ChannelRow | undefined) {
  const target = row?.target ?? "";
  const mail = c === "EMAIL" ? mailSender() : null;
  // 실제 공급자가 있는 채널만 연결됨. 이메일은 메일 공급자가 있고 주소가 올바를 때. 나머지는 공급자(어댑터)가 아직 없다.
  const connected = c === "EMAIL" && !!mail && EMAIL.test(target);
  return {
    channel: c,
    target,
    minSeverity: row?.minSeverity ?? CHANNEL_DEFAULT[c].minSeverity,
    includeNight: row?.includeNight ?? CHANNEL_DEFAULT[c].includeNight,
    status: connected ? ("CONNECTED" as const) : row?.lastError ? ("ERROR" as const) : ("NOT_CONNECTED" as const),
    lastSentAt: row?.lastSentAt ?? null,
    lastError: row?.lastError ?? null,
  };
}

export async function readNotificationSettings(db: PrismaClient, admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  const [rows, routes, usage] = await Promise.all([
    db.adminNotificationChannel.findMany(),
    db.adminNotificationRoute.findMany(),
    monthlyUsage(db),
  ]);
  const channels = CHANNELS.map((c) => channelView(c, rows.find((r) => r.channel === c)));
  const override = new Map(routes.map((r) => [r.eventKey, r]));
  const emailFrom = process.env.MAIL_FROM_ADDRESS?.trim() || null;
  return {
    channels,
    routes: NOTIFY_EVENTS.map((e) => {
      const o = override.get(e.eventKey);
      return {
        eventKey: e.eventKey,
        label: e.label,
        severity: e.severity,
        slack: o?.slack ?? e.slack,
        email: o?.email ?? e.email,
        sms: o?.sms ?? e.sms,
        // 빈 목록 = 전체
        roles: (o?.roles ?? e.roles) as string[],
        nightSuppress: o?.nightSuppress ?? e.nightSuppress,
        nightSuppressible: e.severity !== "URGENT",
        isDefault: !o,
      };
    }),
    // 파트너스 발신 프로필(읽기만, 플랫폼 → 파트너스). 알림톡 프로필·문자 발신번호는 연동 전이라 비어 있고, 이메일은 환경변수의 발신 주소와 메일 공급자 유무로 본다.
    senderProfiles: {
      alimtalk: { profile: null as string | null, status: "NOT_CONNECTED" as const },
      sms: { senderNumber: null as string | null, status: "NOT_CONNECTED" as const },
      email: { address: emailFrom, status: emailFrom && mailSender() ? ("CONNECTED" as const) : ("NOT_CONNECTED" as const) },
      usage,
    },
    updatedAt: [...rows.map((r) => r.lastSentAt), ...routes.map((r) => r.updatedAt)].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
  };
}

// 이번 달(KST) 사용량: 알림톡·문자는 발송 충전 원장의 성공 차감 건수, 이메일은 보낸 메일 수
async function monthlyUsage(db: PrismaClient) {
  const now = new Date();
  const k = new Date(now.getTime() + KST);
  const monthStart = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1) - KST);
  const month = `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, "0")}`;
  const ledger = (channels: ("ALIMTALK" | "SMS" | "LMS")[]) => db.sellerMessageLedger.aggregate({ _sum: { quantity: true }, where: { type: "DEBIT", status: "SUCCEEDED", channel: { in: channels }, createdAt: { gte: monthStart } } });
  const [alimtalk, sms, email] = await Promise.all([ledger(["ALIMTALK"]), ledger(["SMS", "LMS"]), db.mailDelivery.count({ where: { status: "SENT", createdAt: { gte: monthStart } } })]);
  return { month, alimtalk: alimtalk._sum.quantity ?? 0, sms: sms._sum.quantity ?? 0, email };
}

type Meta = { ip?: string | null; userAgent?: string | null };
type Parsed = { channels: { channel: AdminNotifyChannel; target?: string; minSeverity?: AdminAlertSeverity; includeNight?: boolean }[]; routes: { eventKey: string; slack: boolean; email: boolean; sms: boolean; roles: PlatformAdminRole[]; nightSuppress: boolean }[] };

function parseBody(raw: unknown): { ok: true; value: Parsed } | { ok: false; reason: NotificationSettingsRejection } {
  const b = obj(raw);
  if (!b) return { ok: false, reason: "invalid_body" };
  const out: Parsed = { channels: [], routes: [] };
  if (b.channels !== undefined) {
    const ch = obj(b.channels);
    if (!ch) return { ok: false, reason: "invalid_channel" };
    for (const [name, v] of Object.entries(ch)) {
      if (!(CHANNELS as readonly string[]).includes(name)) return { ok: false, reason: "invalid_channel" };
      const c = obj(v);
      if (!c) return { ok: false, reason: "invalid_body" };
      const item: Parsed["channels"][number] = { channel: name as AdminNotifyChannel };
      if (c.target !== undefined) {
        if (typeof c.target !== "string") return { ok: false, reason: "invalid_target" };
        let t = c.target.trim() === "" ? "" : cleanText(c.target, TARGET_MAX, "name");
        if (t === null) return { ok: false, reason: "invalid_target" };
        if (name === "EMAIL" && t !== "" && !EMAIL.test(t)) return { ok: false, reason: "invalid_target" };
        if (name === "EXTERNAL_MONITOR" && t !== "") {
          t = cleanMonitorTarget(t);
          if (t === null) return { ok: false, reason: "invalid_target" };
        }
        item.target = t;
      }
      if (c.minSeverity !== undefined) {
        if (typeof c.minSeverity !== "string" || !(SEVERITIES as readonly string[]).includes(c.minSeverity)) return { ok: false, reason: "invalid_severity" };
        item.minSeverity = c.minSeverity as AdminAlertSeverity;
      }
      if (c.includeNight !== undefined) {
        if (typeof c.includeNight !== "boolean") return { ok: false, reason: "invalid_body" };
        item.includeNight = c.includeNight;
      }
      out.channels.push(item);
    }
  }
  if (b.routes !== undefined) {
    if (!Array.isArray(b.routes) || b.routes.length > NOTIFY_EVENTS.length) return { ok: false, reason: "invalid_route" };
    const seen = new Set<string>();
    for (const r of b.routes) {
      const o = obj(r);
      if (!o || typeof o.eventKey !== "string") return { ok: false, reason: "invalid_route" };
      const def = EVENT.get(o.eventKey);
      if (!def || seen.has(o.eventKey)) return { ok: false, reason: "invalid_event" };
      seen.add(o.eventKey);
      for (const k of ["slack", "email", "sms", "nightSuppress"] as const) if (typeof o[k] !== "boolean") return { ok: false, reason: "invalid_route" };
      if (!Array.isArray(o.roles) || o.roles.length > ROLES.length || !o.roles.every((x) => typeof x === "string" && (ROLES as readonly string[]).includes(x)) || new Set(o.roles).size !== o.roles.length) return { ok: false, reason: "invalid_roles" };
      if (def.severity === "URGENT" && o.nightSuppress === true) return { ok: false, reason: "urgent_no_night_suppress" };
      out.routes.push({ eventKey: o.eventKey, slack: o.slack as boolean, email: o.email as boolean, sms: o.sms as boolean, roles: o.roles as PlatformAdminRole[], nightSuppress: o.nightSuppress as boolean });
    }
  }
  return { ok: true, value: out };
}

// 바꾸기. 본문 { channels?: { SLACK|EMAIL|SMS|EXTERNAL_MONITOR: { target?, minSeverity?, includeNight? } }, routes?: [{ eventKey, slack, email, sms, roles[], nightSuppress }] }(보낸 것만).
export async function updateNotificationSettings(db: PrismaClient, admin: AdminSessionContext, raw: unknown, meta: Meta = {}) {
  if (!adminCan(admin.admin.role, "system.manage")) throw forbidden();
  const p = parseBody(raw);
  if (!p.ok) return p;
  const changedChannels: string[] = [];
  const changedRoutes: string[] = [];
  await db.$transaction(async (tx) => {
    for (const c of p.value.channels) {
      const cur = await tx.adminNotificationChannel.findUnique({ where: { channel: c.channel } });
      const next = { target: c.target ?? cur?.target ?? "", minSeverity: c.minSeverity ?? cur?.minSeverity ?? CHANNEL_DEFAULT[c.channel].minSeverity, includeNight: c.includeNight ?? cur?.includeNight ?? CHANNEL_DEFAULT[c.channel].includeNight };
      if (cur && cur.target === next.target && cur.minSeverity === next.minSeverity && cur.includeNight === next.includeNight) continue;
      await tx.adminNotificationChannel.upsert({ where: { channel: c.channel }, create: { channel: c.channel, ...next, updatedByAdminId: admin.admin.id }, update: { ...next, lastError: null, updatedByAdminId: admin.admin.id } });
      changedChannels.push(c.channel);
    }
    for (const r of p.value.routes) {
      const def = EVENT.get(r.eventKey)!;
      const cur = await tx.adminNotificationRoute.findUnique({ where: { eventKey: r.eventKey } });
      const sameAsDefault = r.slack === def.slack && r.email === def.email && r.sms === def.sms && r.nightSuppress === def.nightSuppress && sameSet(r.roles, def.roles);
      if (sameAsDefault) {
        if (cur) {
          await tx.adminNotificationRoute.delete({ where: { eventKey: r.eventKey } });
          changedRoutes.push(r.eventKey);
        }
        continue;
      }
      if (cur && cur.slack === r.slack && cur.email === r.email && cur.sms === r.sms && cur.nightSuppress === r.nightSuppress && sameSet(cur.roles, r.roles)) continue;
      await tx.adminNotificationRoute.upsert({ where: { eventKey: r.eventKey }, create: { ...r, updatedByAdminId: admin.admin.id }, update: { ...r, updatedByAdminId: admin.admin.id } });
      changedRoutes.push(r.eventKey);
    }
    if (changedChannels.length + changedRoutes.length > 0) {
      await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "admin.notification_settings.update", targetType: "AdminNotificationSettings", targetId: "1", after: { channels: changedChannels, routes: changedRoutes }, ip: meta.ip, userAgent: meta.userAgent });
    }
  });
  return { ok: true as const, changed: { channels: changedChannels, routes: changedRoutes }, settings: await readNotificationSettings(db, admin) };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

// 기본값 복원: 이벤트별 라우팅의 바꾼 값을 모두 지운다(채널 설정은 그대로).
export async function resetNotificationRoutes(db: PrismaClient, admin: AdminSessionContext, meta: Meta = {}) {
  if (!adminCan(admin.admin.role, "system.manage")) throw forbidden();
  const r = await db.adminNotificationRoute.deleteMany({});
  if (r.count > 0) await writeAudit(db, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "admin.notification_routes.reset", targetType: "AdminNotificationSettings", targetId: "1", after: { routes: r.count }, ip: meta.ip, userAgent: meta.userAgent });
  return { ok: true as const, reset: r.count, settings: await readNotificationSettings(db, admin) };
}

export type TestResult = { channel: AdminNotifyChannel; status: "SENT" | "NOT_CONNECTED" | "FAILED" };

// 테스트 보내기: 실제로 연결된 채널(이메일)만 보낸다. 나머지는 NOT_CONNECTED로 알려 주고 아무것도 보내지 않는다(새 외부 서비스 가입·유료 연동 없음).
// 본문 { channels?: ["EMAIL", ...] }(없으면 4채널 모두 시도). 보낸 시각은 채널의 마지막 발송에 남기고, 실패는 마지막 오류에 남긴다.
export async function sendNotificationTest(db: PrismaClient, admin: AdminSessionContext, raw: unknown, meta: Meta = {}) {
  if (!adminCan(admin.admin.role, "system.manage")) throw forbidden();
  const b = obj(raw) ?? {};
  let wanted: AdminNotifyChannel[] = [...CHANNELS];
  if (b.channels !== undefined) {
    if (!Array.isArray(b.channels) || !b.channels.every((x) => typeof x === "string" && (CHANNELS as readonly string[]).includes(x))) return { ok: false as const, reason: "invalid_channel" as const };
    wanted = [...new Set(b.channels as AdminNotifyChannel[])];
  }
  const rows = await db.adminNotificationChannel.findMany();
  const results: TestResult[] = [];
  for (const c of wanted) {
    const view = channelView(c, rows.find((r) => r.channel === c));
    if (view.status !== "CONNECTED") {
      results.push({ channel: c, status: "NOT_CONNECTED" });
      continue;
    }
    const sender = mailSender();
    try {
      await sender!.send(
        { to: view.target, subject: "[ONQ] 알림 채널 테스트", html: "<p>마스터 관리자 알림 채널 테스트입니다. 이 메일을 받으셨다면 이메일 채널이 정상입니다.</p>", text: "마스터 관리자 알림 채널 테스트입니다. 이 메일을 받으셨다면 이메일 채널이 정상입니다." },
        { idempotencyKey: `admin-notify-test:${admin.admin.id}:${Date.now()}` },
      );
      await db.adminNotificationChannel.update({ where: { channel: c }, data: { lastSentAt: new Date(), lastError: null } });
      results.push({ channel: c, status: "SENT" });
    } catch {
      await db.adminNotificationChannel.update({ where: { channel: c }, data: { lastError: "send_failed" } });
      results.push({ channel: c, status: "FAILED" });
    }
  }
  await writeAudit(db, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "admin.notification_test", targetType: "AdminNotificationSettings", targetId: "1", after: { results: results.map((r) => `${r.channel}:${r.status}`) }, ip: meta.ip, userAgent: meta.userAgent });
  return { ok: true as const, results, settings: await readNotificationSettings(db, admin) };
}
