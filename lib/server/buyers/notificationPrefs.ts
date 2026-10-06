import type { PrismaClient } from "@prisma/client";
import { SIGNUP_CONSENT_VERSIONS } from "./consent";
import { readMarketingConsent, setMarketingConsent, type MarketingConsentState } from "./marketingConsent";

// 구매자 알림 설정(SH-025 「알림 종류 × 채널」 표). 종류 6개 × 채널 2개(알림톡·문자 = MESSAGE, 이메일 = EMAIL).
// - 필수(ORDER 주문·결제, QUEUE 내 차례): 두 채널 모두 항상 켬, 끌 수 없다.
// - SHIPPING 배송: 두 채널을 끌 수 있다(기본 켬).
// - 광고성(BROADCAST_START 방송 시작, DISCOUNT_RESTOCK 할인·재입고, BENEFIT 혜택·이벤트): 이메일만(알림톡·문자 열 없음, PRODUCT_SCOPE 광고성 알림톡 금지).
//   광고성은 마케팅 수신 동의가 있어야 받는다. BENEFIT 이메일 칸 = 마케팅 수신 동의 그 자체(켜면 동의, 끄면 철회, marketingConsent.ts와 같은 기록·감사).
//   방송 시작·할인·재입고 이메일 칸은 따로 저장하되(기본 켬), 동의가 없으면 꺼진 것으로 본다. 동의 없이 켜는 요청은 거절한다.
// 끌 수 있는 칸만 BuyerNotificationPref에 저장하고 줄이 없으면 켬이다. 발송 쪽은 아래 notifyEnabled로 이 설정을 확인한다.
export const NOTIFICATION_KINDS = ["ORDER", "QUEUE", "SHIPPING", "BROADCAST_START", "DISCOUNT_RESTOCK", "BENEFIT"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationChannel = "MESSAGE" | "EMAIL";

const REQUIRED = new Set<NotificationKind>(["ORDER", "QUEUE"]);
const AD = new Set<NotificationKind>(["BROADCAST_START", "DISCOUNT_RESTOCK", "BENEFIT"]);
const STORED = new Set<NotificationKind>(["SHIPPING", "BROADCAST_START", "DISCOUNT_RESTOCK"]);

export const NOTIFICATION_PREF_MESSAGES = {
  invalid_notification_prefs: "알림 설정을 다시 선택해 주세요",
  required_notification: "주문·결제와 내 차례 알림은 거래에 꼭 필요해서 끌 수 없어요",
  marketing_consent_required: "혜택·이벤트 알림을 켜야 받을 수 있어요",
  consent_outdated: "약관이 바뀌었어요. 다시 확인하고 동의해 주세요",
} as const;
export const NOTIFICATION_PREF_STATUS = { invalid_notification_prefs: 400, required_notification: 400, marketing_consent_required: 409, consent_outdated: 409 } as const;

type Scope = { sellerId: string; buyerMemberId: string };
type Meta = { ip?: string | null; userAgent?: string | null };
type Cell = { message: boolean | null; email: boolean | null };
export type NotificationPrefsState = {
  items: { kind: NotificationKind; required: boolean; ad: boolean; message: boolean | null; email: boolean | null }[];
  marketing: MarketingConsentState;
};

// 이 회원의 저장된 칸(없으면 빈 맵)과 마케팅 동의 여부로 표를 만든다. null = 그 칸이 없음(광고성 줄의 알림톡·문자).
function build(stored: { kind: string; channel: string; enabled: boolean }[], marketing: MarketingConsentState): NotificationPrefsState {
  const val = (kind: NotificationKind, channel: NotificationChannel) => stored.find((s) => s.kind === kind && s.channel === channel)?.enabled ?? true;
  const items = NOTIFICATION_KINDS.map((kind) => {
    const cell: Cell = REQUIRED.has(kind)
      ? { message: true, email: true }
      : kind === "SHIPPING"
        ? { message: val(kind, "MESSAGE"), email: val(kind, "EMAIL") }
        : { message: null, email: kind === "BENEFIT" ? marketing.agreed : marketing.agreed && val(kind, "EMAIL") };
    return { kind, required: REQUIRED.has(kind), ad: AD.has(kind), ...cell };
  });
  return { items, marketing };
}

export async function readNotificationPrefs(db: PrismaClient, scope: Scope): Promise<NotificationPrefsState | null> {
  const marketing = await readMarketingConsent(db, scope);
  if (!marketing) return null;
  const stored = await db.buyerNotificationPref.findMany({ where: scope, select: { kind: true, channel: true, enabled: true } });
  return build(stored, marketing);
}

type Parsed = { cells: { kind: NotificationKind; channel: NotificationChannel; enabled: boolean }[]; benefit: boolean | undefined };
// 본문: { prefs: { SHIPPING?: { message?, email? }, BROADCAST_START?: { email? }, ... }, marketingVersion?: string(혜택·이벤트를 켤 때 화면이 보여 준 문서 버전) }
function parse(raw: unknown): Parsed | "invalid_notification_prefs" | "required_notification" {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const p = b.prefs;
  if (!p || typeof p !== "object" || Array.isArray(p)) return "invalid_notification_prefs";
  const cells: Parsed["cells"] = [];
  let benefit: boolean | undefined;
  for (const [kind, v] of Object.entries(p as Record<string, unknown>)) {
    if (!(NOTIFICATION_KINDS as readonly string[]).includes(kind) || !v || typeof v !== "object" || Array.isArray(v)) return "invalid_notification_prefs";
    const k = kind as NotificationKind;
    const c = v as Record<string, unknown>;
    if (Object.keys(c).some((x) => x !== "message" && x !== "email")) return "invalid_notification_prefs";
    for (const [key, channel] of [["message", "MESSAGE"], ["email", "EMAIL"]] as const) {
      const x = c[key];
      if (x === undefined) continue;
      if (typeof x !== "boolean") return "invalid_notification_prefs";
      if (REQUIRED.has(k)) {
        if (!x) return "required_notification";
        continue;
      }
      if (channel === "MESSAGE" && AD.has(k)) return "invalid_notification_prefs"; // 광고성 줄에는 알림톡·문자 칸이 없다
      if (k === "BENEFIT") benefit = x;
      else cells.push({ kind: k, channel, enabled: x });
    }
  }
  return { cells, benefit };
}

export async function setNotificationPrefs(db: PrismaClient, scope: Scope, raw: unknown, meta: Meta = {}) {
  const parsed = parse(raw);
  if (typeof parsed === "string") return { ok: false as const, reason: parsed };
  const body = raw as Record<string, unknown>;
  // 혜택·이벤트 칸 = 마케팅 동의. 바뀔 때만 마케팅 동의 기록(철회 시각·감사 로그)을 같은 규칙으로 남긴다.
  const cur = await readMarketingConsent(db, scope);
  if (!cur) return { ok: false as const, reason: "not_found" as const };
  // 동의 없이 광고성 칸을 켜는 요청은 동의 기록을 바꾸기 전에 거절한다(오류 응답인데 동의 상태만 바뀌는 일이 없게)
  if (!(parsed.benefit ?? cur.agreed) && parsed.cells.some((c) => AD.has(c.kind) && c.enabled)) return { ok: false as const, reason: "marketing_consent_required" as const };
  if (parsed.benefit !== undefined && (parsed.benefit !== cur.agreed || (parsed.benefit && cur.version !== SIGNUP_CONSENT_VERSIONS.marketing))) {
    const r = await setMarketingConsent(db, scope, { agreed: parsed.benefit, marketingVersion: body.marketingVersion }, meta);
    if (!r.ok) return r.reason === "not_found" ? { ok: false as const, reason: "not_found" as const } : { ok: false as const, reason: r.reason === "consent_outdated" ? ("consent_outdated" as const) : ("invalid_notification_prefs" as const) };
  }
  await db.$transaction(async (tx) => {
    // 같은 회원의 동시 저장을 한 줄로 세운다
    await tx.$queryRaw`SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid FOR UPDATE`;
    for (const c of parsed.cells) {
      await tx.buyerNotificationPref.upsert({
        where: { buyerMemberId_kind_channel: { buyerMemberId: scope.buyerMemberId, kind: c.kind, channel: c.channel } },
        create: { ...scope, kind: c.kind, channel: c.channel, enabled: c.enabled },
        update: { enabled: c.enabled, updatedAt: new Date() },
      });
    }
  });
  const state = await readNotificationPrefs(db, scope);
  return state ? { ok: true as const, state } : { ok: false as const, reason: "not_found" as const };
}

// 발송 쪽 확인 지점: 이 회원이 이 종류를 이 채널로 받아도 되는가. 필수 종류는 항상 true, 광고성은 마케팅 동의가 있어야 한다.
// 알림톡·문자 채널이 없는 광고성 종류는 MESSAGE가 항상 false(광고성 알림톡 금지).
export async function notifyEnabled(db: Pick<PrismaClient, "buyerMember" | "buyerNotificationPref">, scope: Scope, kind: NotificationKind, channel: NotificationChannel): Promise<boolean> {
  if (REQUIRED.has(kind)) return true;
  if (AD.has(kind)) {
    if (channel === "MESSAGE") return false;
    const m = await db.buyerMember.findFirst({ where: { id: scope.buyerMemberId, sellerId: scope.sellerId, deletedAt: null }, select: { marketingConsentAt: true } });
    if (!m?.marketingConsentAt) return false;
    if (!STORED.has(kind)) return true;
  }
  const row = await db.buyerNotificationPref.findUnique({ where: { buyerMemberId_kind_channel: { buyerMemberId: scope.buyerMemberId, kind, channel } }, select: { enabled: true } });
  return row?.enabled ?? true;
}
