import type { MemberMessageChannel, MemberMessageKind, MemberMessageTarget } from "@prisma/client";
import { cleanText } from "../text/clean";

// 회원 대상 발송 규칙(순수 함수, SA-049). 서비스(service.ts)가 입력을 검사하고 보낼 시각·최종 문구를 정하는 데 쓴다.
export const TITLE_MAX = 40;
export const BODY_MAX = 500;
export const GRADE_IDS_MAX = 10;
export const PICK_MAX = 200;
export const RECIPIENT_MAX = 10_000;
export const DAILY_CAP = 2; // 같은 회원 하루(KST) 최대 받는 발송 수
export const SCHEDULE_MAX_DAYS = 30;
export const AD_START_HOUR = 8; // 광고성은 08:00 ~ 21:00(KST)에만
export const AD_END_HOUR = 21;
export const LONG_MESSAGE_CHARS = 90; // 90자를 넘으면 긴 문자
export const OPT_OUT_TEXT = "무료 수신거부 [수신거부 번호]"; // 실제 번호는 발송 채널이 정해질 때 채운다

export const KINDS: readonly MemberMessageKind[] = ["AD", "INFO"];
export const CHANNELS: readonly MemberMessageChannel[] = ["ALIMTALK_SMS", "ALIMTALK", "MAIL"];
export const TARGETS: readonly MemberMessageTarget[] = ["ALL", "GRADE", "WISHED", "BOUGHT_30D", "NOT_BOUGHT_90D", "PRODUCT_BOUGHT", "PICKED"];

export type MessageRejection = "invalid_title" | "invalid_body" | "invalid_kind" | "invalid_channel" | "invalid_target" | "invalid_schedule" | "invalid_send_mode";

export const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export type TargetSpec =
  | { type: "ALL" | "BOUGHT_30D" | "NOT_BOUGHT_90D" }
  | { type: "GRADE"; gradeIds: string[] }
  | { type: "WISHED" | "PRODUCT_BOUGHT"; productId: string }
  | { type: "PICKED"; memberIds: string[] };

export function parseTarget(raw: unknown): TargetSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.type !== "string" || !(TARGETS as readonly string[]).includes(o.type)) return null;
  const idList = (v: unknown, max: number) => (Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(isUuid) && new Set(v).size === v.length ? (v as string[]) : null);
  switch (o.type as MemberMessageTarget) {
    case "ALL":
    case "BOUGHT_30D":
    case "NOT_BOUGHT_90D":
      return { type: o.type as "ALL" | "BOUGHT_30D" | "NOT_BOUGHT_90D" };
    case "GRADE": {
      const gradeIds = idList(o.gradeIds, GRADE_IDS_MAX);
      return gradeIds ? { type: "GRADE", gradeIds } : null;
    }
    case "WISHED":
    case "PRODUCT_BOUGHT":
      return isUuid(o.productId) ? { type: o.type as "WISHED" | "PRODUCT_BOUGHT", productId: o.productId } : null;
    case "PICKED": {
      const memberIds = idList(o.memberIds, PICK_MAX);
      return memberIds ? { type: "PICKED", memberIds } : null;
    }
  }
}
export const targetParams = (t: TargetSpec): Record<string, unknown> => {
  const { type: _type, ...rest } = t;
  return rest;
};

export type NewMessageInput = {
  title: string;
  kind: MemberMessageKind;
  channel: MemberMessageChannel;
  body: string;
  target: TargetSpec;
  sendMode: "NOW" | "SCHEDULE";
  scheduledAt: Date | null;
};

// 새 발송·수정 입력. 보낼 시각은 「지금」이거나 ISO 시각(예약).
export function parseMessage(raw: Record<string, unknown>): { ok: true; v: NewMessageInput } | { ok: false; reason: MessageRejection } {
  const title = cleanText(raw.title, TITLE_MAX, "name");
  if (!title) return { ok: false, reason: "invalid_title" };
  if (typeof raw.kind !== "string" || !(KINDS as readonly string[]).includes(raw.kind)) return { ok: false, reason: "invalid_kind" };
  if (typeof raw.channel !== "string" || !(CHANNELS as readonly string[]).includes(raw.channel)) return { ok: false, reason: "invalid_channel" };
  const body = cleanText(raw.body, BODY_MAX, "memo");
  if (!body) return { ok: false, reason: "invalid_body" };
  const target = parseTarget(raw.target);
  if (!target) return { ok: false, reason: "invalid_target" };
  if (raw.sendMode !== "NOW" && raw.sendMode !== "SCHEDULE") return { ok: false, reason: "invalid_send_mode" };
  let scheduledAt: Date | null = null;
  if (raw.sendMode === "SCHEDULE") {
    if (typeof raw.scheduledAt !== "string") return { ok: false, reason: "invalid_schedule" };
    const d = new Date(raw.scheduledAt);
    if (Number.isNaN(d.getTime())) return { ok: false, reason: "invalid_schedule" };
    scheduledAt = d;
  }
  return { ok: true, v: { title, kind: raw.kind as MemberMessageKind, channel: raw.channel as MemberMessageChannel, body, target, sendMode: raw.sendMode, scheduledAt } };
}

// ───────────── 시각(KST) ─────────────
const KST_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;
export const kstHour = (d: Date) => new Date(d.getTime() + KST_MS).getUTCHours();
export const kstDayStart = (d: Date) => new Date(Math.floor((d.getTime() + KST_MS) / DAY_MS) * DAY_MS - KST_MS);
export const kstMonthStart = (d: Date) => {
  const k = new Date(d.getTime() + KST_MS);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1) - KST_MS);
};
export const inAdWindow = (d: Date) => kstHour(d) >= AD_START_HOUR && kstHour(d) < AD_END_HOUR;
// 광고성 시간 밖이면 다음 08:00(KST), 안이면 그대로
export function nextAdTime(d: Date): Date {
  if (inAdWindow(d)) return d;
  const start = kstDayStart(d);
  const eight = new Date(start.getTime() + AD_START_HOUR * 3600_000);
  return d.getTime() < eight.getTime() ? eight : new Date(eight.getTime() + DAY_MS);
}

// 최종 문구: 광고성은 (광고) · 쇼핑몰 이름 · 무료 수신거부를 자동으로 붙인다
export function renderBody(kind: MemberMessageKind, shopName: string, body: string): string {
  return kind === "AD" ? `(광고) [${shopName}] ${body}\n${OPT_OUT_TEXT}` : `[${shopName}] ${body}`;
}
// 광고성 최종 문구는 (광고) 표기와 무료 수신거부 문구가 모두 있어야 한다(정보통신망법). 하나라도 없으면 기록하지 않는다.
export const adTextOk = (rendered: string) => rendered.startsWith("(광고)") && rendered.includes(OPT_OUT_TEXT);
export const isLongMessage = (rendered: string) => [...rendered].length > LONG_MESSAGE_CHARS;
