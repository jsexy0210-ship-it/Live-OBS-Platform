import { Prisma, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 오버레이 레이아웃(SA-051 편집기 → OV-001 9:16 · OV-002 16:9, docs/DESIGN_PROMPT.md 「OBS 오버레이」).
// - 판매자·비율마다 레이아웃 1개(OverlayLayout). 없으면 기본 템플릿 queue_focus. 위치·크기는 화면 대비 %(0~100).
// - 위젯은 아래 종류만, 속성은 종류별 허용 목록과 값 범위만 받는다(모르는 키·잘못된 값은 저장하지 않고 400).
//   종류마다 하나씩(신규 주문 알림만 첫 주문·재주문·VIP 각 하나).
// - 저장은 expectedVersion이 지금 version과 같을 때만(두 창 동시 편집 덮어쓰기 방지, 409 version_conflict).
// - 기본 템플릿 3종(코드)과 「내 템플릿」(OverlayTemplate, 판매자당 20개). 템플릿으로 초기화하면 그 위젯을 그대로 복사한다.
// - 편집·조회는 OVERLAY_EDIT(대표자·권한 직원), 로그 추적 overlay.layout.update·reset, overlay.template.create·delete.
// - 오버레이 주소(토큰)용 공개 조회는 위젯 값만 준다(판매자 정보 없음).

export const ASPECTS = ["9x16", "16x9"] as const;
export type Aspect = (typeof ASPECTS)[number];
export const WIDGET_TYPES = ["HALL_OF_FAME", "NOTICE", "SHOP_INFO", "CURRENT_ORDER", "QUEUE", "OPEN_TIMER", "NEW_ORDER_ALERT", "EVENT_CARD", "PURCHASE_RANKING"] as const;
// 기본 템플릿 3종에 들어 있는 위젯. 이벤트 할인 카드·구매 랭킹은 판매자가 편집기에서 직접 켠다(저장된 레이아웃·기본 템플릿 수치는 그대로).
export const BUILTIN_WIDGET_TYPES = ["HALL_OF_FAME", "NOTICE", "SHOP_INFO", "CURRENT_ORDER", "QUEUE", "OPEN_TIMER", "NEW_ORDER_ALERT"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export const MAX_WIDGETS = 20;
export const MAX_TEMPLATES = 20;
export const APPEAR_KINDS = ["none", "fade", "up", "left", "flip"] as const;
export const ALERT_VARIANTS = ["first", "repeat", "vip"] as const;

type PropValue = string | number | boolean;
export type Widget = { id: string; type: WidgetType; visible: boolean; x: number; y: number; w: number; h: number; z: number; props: Record<string, PropValue> };

const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const ID_RE = /^[a-z0-9_-]{1,40}$/;
type Spec =
  | { kind: "color" }
  | { kind: "text"; max: number; lines?: boolean }
  | { kind: "num"; min: number; max: number; int?: boolean; step?: number }
  | { kind: "bool" }
  | { kind: "enum"; values: readonly string[] };
const color: Spec = { kind: "color" };
const pct: Spec = { kind: "num", min: 0, max: 1 };

// 모든 위젯 공통 속성(DESIGN_PROMPT 「위젯마다」)
const COMMON: Record<string, Spec> = {
  title: { kind: "text", max: 40 },
  // 문구 틀: {닉네임}·{상품}·{수량}·{카드명}·{건수} 자리표시를 쓴다(화면이 바꿔 그림)
  format: { kind: "text", max: 100 },
  accentColor: color,
  titleColor: color,
  nicknameColor: color,
  bodyColor: color,
  titleBgColor: color,
  titleBgOpacity: pct,
  cardBgColor: color,
  cardBgOpacity: pct,
  borderColor: color,
  radius: { kind: "num", min: 0, max: 64, int: true },
  fontSize: { kind: "num", min: 8, max: 200, int: true },
  fontWeight: { kind: "num", min: 100, max: 900, int: true, step: 100 },
  glow: { kind: "bool" },
  marquee: { kind: "bool" },
  ticker: { kind: "bool" },
  flowSec: { kind: "num", min: 1, max: 120 },
  appear: { kind: "enum", values: APPEAR_KINDS },
  appearSec: { kind: "num", min: 0, max: 10 },
};
const EXTRA: Partial<Record<WidgetType, Record<string, Spec>>> = {
  NOTICE: { text: { kind: "text", max: 200, lines: true } },
  // 주문대기: 「오픈」 영역과 「대기」 영역 색을 따로
  QUEUE: {
    openTitleColor: color,
    openNicknameColor: color,
    openProductColor: color,
    openBorderColor: color,
    waitTitleColor: color,
    waitNicknameColor: color,
    waitProductColor: color,
    waitBorderColor: color,
    waitIndexColor: color,
    waitCountColor: color,
    rows: { kind: "num", min: 1, max: 10, int: true },
  },
  HALL_OF_FAME: { rows: { kind: "num", min: 1, max: 10, int: true } },
  // 구매 랭킹: 지금 방송 구매 수량 순위(state purchaseRanking, 최대 RANKING_MAX명)에서 위에서 rows명만 보여 준다
  PURCHASE_RANKING: { rows: { kind: "num", min: 1, max: 10, int: true } },
  // 신규 주문 알림: 첫 주문·재주문·VIP를 따로
  NEW_ORDER_ALERT: { variant: { kind: "enum", values: ALERT_VARIANTS }, durationSec: { kind: "num", min: 1, max: 30 } },
};

function checkProp(spec: Spec, v: unknown): PropValue | null {
  switch (spec.kind) {
    case "color":
      return typeof v === "string" && COLOR_RE.test(v) ? v.toLowerCase() : null;
    case "bool":
      return typeof v === "boolean" ? v : null;
    case "enum":
      return typeof v === "string" && spec.values.includes(v) ? v : null;
    case "num": {
      if (typeof v !== "number" || !Number.isFinite(v) || v < spec.min || v > spec.max) return null;
      if (spec.int && !Number.isInteger(v)) return null;
      if (spec.step && v % spec.step !== 0) return null;
      return Math.round(v * 100) / 100;
    }
    case "text":
      if (v === "") return "";
      return cleanText(v, spec.max, spec.lines ? "multiline" : "memo");
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const isPct = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

// 위젯 배열 검사. 통과하면 정리한 배열, 아니면 null.
export function parseWidgets(raw: unknown): Widget[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_WIDGETS) return null;
  const out: Widget[] = [];
  const ids = new Set<string>();
  const kinds = new Set<string>();
  for (const w of raw) {
    if (!w || typeof w !== "object" || Array.isArray(w)) return null;
    const o = w as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.some((k) => !["id", "type", "visible", "x", "y", "w", "h", "z", "props"].includes(k))) return null;
    if (typeof o.id !== "string" || !ID_RE.test(o.id) || ids.has(o.id)) return null;
    if (!WIDGET_TYPES.includes(o.type as WidgetType) || typeof o.visible !== "boolean") return null;
    if (![o.x, o.y, o.w, o.h].every(isPct)) return null;
    const [x, y, wd, h] = [o.x, o.y, o.w, o.h].map((v) => round2(v as number));
    if (wd <= 0 || h <= 0 || x + wd > 100 || y + h > 100) return null;
    if (typeof o.z !== "number" || !Number.isInteger(o.z) || o.z < 0 || o.z > 99) return null;
    const type = o.type as WidgetType;
    const allowed = { ...COMMON, ...(EXTRA[type] ?? {}) };
    const rawProps = o.props ?? {};
    if (typeof rawProps !== "object" || rawProps === null || Array.isArray(rawProps)) return null;
    const props: Record<string, PropValue> = {};
    for (const [k, v] of Object.entries(rawProps as Record<string, unknown>)) {
      const spec = allowed[k];
      if (!spec) return null;
      const val = checkProp(spec, v);
      if (val === null) return null;
      props[k] = val;
    }
    if (type === "NEW_ORDER_ALERT" && typeof props.variant !== "string") return null;
    const kindKey = type === "NEW_ORDER_ALERT" ? `${type}:${props.variant}` : type;
    if (kinds.has(kindKey)) return null;
    kinds.add(kindKey);
    ids.add(o.id);
    out.push({ id: o.id, type, visible: o.visible, x, y, w: wd, h, z: o.z, props });
  }
  return out;
}

// ---- 기본 템플릿 3종(비율마다). 값은 디자인 OV-008 「기본 템플릿 3종 수치표」 그대로 ----
// 7종 위젯을 모두 둔다. 시작 타이머는 기본 숨김. 신규 주문 알림은 공지 자리에 겹쳐 맨 위(z9)에 durationSec 동안 뜬다.
// 세로형은 위쪽 절반 안에 모으고(아래는 유튜브 채팅이 덮음), 가로형은 가운데를 비운다. 저장된 판매자 레이아웃에는 영향 없음.
const w = (id: string, type: WidgetType, x: number, y: number, wd: number, h: number, z: number, props: Record<string, PropValue> = {}, visible = true): Widget => ({
  id,
  type,
  visible,
  x,
  y,
  w: wd,
  h,
  z,
  props: { flowSec: 20, appear: "up", appearSec: 0.7, cardBgOpacity: 0.9, titleBgOpacity: 0.94, radius: 16, ...props },
});
const timerOff = (x: number, y: number, wd: number, h: number) => w("open_timer", "OPEN_TIMER", x, y, wd, h, 5, {}, false);
const notice = (x: number, y: number, wd: number, h: number) => [
  w("notice", "NOTICE", x, y, wd, h, 1),
  w("alert_first", "NEW_ORDER_ALERT", x, y, wd, h, 9, { variant: "first", durationSec: 6 }),
];

export const BUILTIN_TEMPLATES: Record<string, { name: string; layouts: Record<Aspect, Widget[]> }> = {
  queue_focus: {
    name: "대기열형",
    layouts: {
      "9x16": [
        w("hall", "HALL_OF_FAME", 56.7, 23.4, 38.9, 19.9, 2, { rows: 5, ticker: true }),
        ...notice(4.4, 18, 91.2, 4.8),
        w("shop", "SHOP_INFO", 4.4, 15.1, 91.2, 2.3, 1),
        w("current", "CURRENT_ORDER", 4.4, 23.4, 50.7, 10.8, 3, { glow: true, marquee: true }),
        w("queue", "QUEUE", 4.4, 34.9, 50.7, 8.4, 2, { rows: 3 }),
        timerOff(56.7, 43.9, 38.9, 4),
      ],
      "16x9": [
        w("hall", "HALL_OF_FAME", 72.4, 12.6, 25.1, 38.9, 2, { rows: 6, ticker: true }),
        ...notice(72.4, 52.6, 25.1, 14.1),
        w("shop", "SHOP_INFO", 2.5, 12.6, 25.1, 4.1, 1),
        w("current", "CURRENT_ORDER", 2.5, 17.8, 25.1, 19.3, 3, { glow: true, marquee: true }),
        w("queue", "QUEUE", 2.5, 38.1, 25.1, 36.3, 2, { rows: 6 }),
        timerOff(72.4, 67.8, 25.1, 8),
      ],
    },
  },
  spotlight: {
    name: "스포트라이트형",
    layouts: {
      "9x16": [
        w("hall", "HALL_OF_FAME", 4.4, 18, 37, 23.1, 2, { rows: 6, ticker: true }),
        ...notice(43, 35.3, 52.6, 5.8),
        w("shop", "SHOP_INFO", 4.4, 15.1, 91.2, 2.3, 1),
        w("current", "CURRENT_ORDER", 43, 18, 52.6, 13.1, 3, { glow: true, marquee: true, fontSize: 56 }),
        // 한 줄로 흘려 보여 줌
        w("queue", "QUEUE", 43, 31.8, 52.6, 2.9, 2, { rows: 1, ticker: true }),
        timerOff(43, 41.7, 52.6, 4),
      ],
      "16x9": [
        w("hall", "HALL_OF_FAME", 72.3, 38.5, 25.2, 44.4, 2, { rows: 7, ticker: true }),
        ...notice(2.5, 17.8, 25, 13.9),
        w("shop", "SHOP_INFO", 2.5, 12.6, 25, 4.1, 1),
        w("current", "CURRENT_ORDER", 72.3, 12.6, 25.2, 24.8, 3, { glow: true, marquee: true, fontSize: 56 }),
        w("queue", "QUEUE", 2.5, 32.8, 25, 23.3, 2, { rows: 4 }),
        timerOff(2.5, 57.2, 25, 8),
      ],
    },
  },
  minimal: {
    name: "미니형",
    layouts: {
      "9x16": [
        w("hall", "HALL_OF_FAME", 4.4, 29.3, 48.1, 5.8, 1, { rows: 2, title: "" }),
        ...notice(4.4, 35.7, 48.1, 4.4),
        w("shop", "SHOP_INFO", 4.4, 15.1, 48.1, 2.1, 1),
        w("current", "CURRENT_ORDER", 4.4, 17.8, 48.1, 7.7, 2, { marquee: true }),
        w("queue", "QUEUE", 4.4, 26.1, 48.1, 2.5, 1, { rows: 1, ticker: true }),
        timerOff(4.4, 40.7, 48.1, 3.5),
      ],
      "16x9": [
        w("hall", "HALL_OF_FAME", 76.7, 12.6, 20.8, 11.5, 1, { rows: 2, title: "" }),
        ...notice(76.7, 25.2, 20.8, 8.5),
        w("shop", "SHOP_INFO", 2.5, 12.6, 22.9, 3.7, 1),
        w("current", "CURRENT_ORDER", 2.5, 17.4, 25, 13.7, 2, { marquee: true }),
        w("queue", "QUEUE", 2.5, 32.2, 25, 4.4, 1, { rows: 1 }),
        timerOff(2.5, 37.7, 25, 6),
      ],
    },
  },
};
export const DEFAULT_TEMPLATE = "queue_focus";

export const parseAspect = (v: unknown): Aspect | null => (ASPECTS.includes(v as Aspect) ? (v as Aspect) : null);
type Meta = { ip?: string | null; userAgent?: string | null };

async function currentLayout(db: PrismaClient | Prisma.TransactionClient, sellerId: string, aspect: Aspect) {
  const row = await db.overlayLayout.findUnique({ where: { sellerId_aspect: { sellerId, aspect } } });
  if (row) return { aspect, templateKey: row.templateKey, widgets: row.widgets as Widget[], version: row.version, updatedAt: row.updatedAt, isDefault: false };
  return { aspect, templateKey: DEFAULT_TEMPLATE, widgets: BUILTIN_TEMPLATES[DEFAULT_TEMPLATE].layouts[aspect], version: 0, updatedAt: null, isDefault: true };
}

export async function getSellerLayout(db: PrismaClient, ctx: TenantContext, aspect: Aspect) {
  requireSellerRead(ctx, "OVERLAY_EDIT");
  return currentLayout(db, ctx.sellerId, aspect);
}

// 오버레이 주소(토큰)로 보는 레이아웃: 위젯과 version만
export async function getPublicLayout(db: PrismaClient, sellerId: string, aspect: Aspect) {
  const l = await currentLayout(db, sellerId, aspect);
  return { aspect, version: l.version, widgets: l.widgets };
}

export type SaveFailure = "invalid_layout" | "version_conflict" | "template_not_found";

// 저장(전체 교체). expectedVersion: 지금 version(처음이면 0).
export async function saveLayout(
  db: PrismaClient,
  ctx: TenantContext,
  input: { aspect: unknown; widgets: unknown; expectedVersion: unknown; templateKey?: string },
  meta: Meta = {},
): Promise<{ ok: true; layout: Awaited<ReturnType<typeof currentLayout>> } | { ok: false; reason: SaveFailure; current?: number }> {
  requireSellerPermission(ctx, "OVERLAY_EDIT");
  const aspect = parseAspect(input.aspect);
  const widgets = parseWidgets(input.widgets);
  const expected = input.expectedVersion;
  if (!aspect || !widgets || typeof expected !== "number" || !Number.isInteger(expected) || expected < 0) return { ok: false, reason: "invalid_layout" };
  return writeLayout(db, ctx, aspect, widgets, expected, input.templateKey, "overlay.layout.update", meta);
}

async function writeLayout(db: PrismaClient, ctx: TenantContext, aspect: Aspect, widgets: Widget[], expected: number, templateKey: string | undefined, action: string, meta: Meta) {
  return db.$transaction(async (tx) => {
    // 판매자·비율 단위로 줄을 세운다(처음 저장 두 개가 동시에 와도 하나만 통과)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`overlay_layout:${ctx.sellerId}:${aspect}`}))`;
    const cur = await tx.overlayLayout.findUnique({ where: { sellerId_aspect: { sellerId: ctx.sellerId, aspect } }, select: { version: true, templateKey: true } });
    const version = cur?.version ?? 0;
    if (version !== expected) return { ok: false as const, reason: "version_conflict" as const, current: version };
    const key = templateKey ?? cur?.templateKey ?? DEFAULT_TEMPLATE;
    const data = { templateKey: key, widgets: widgets as unknown as Prisma.InputJsonValue, updatedById: ctx.actorType === "SELLER_USER" ? ctx.actorId : null };
    await tx.overlayLayout.upsert({
      where: { sellerId_aspect: { sellerId: ctx.sellerId, aspect } },
      create: { sellerId: ctx.sellerId, aspect, ...data },
      update: { ...data, version: { increment: 1 } },
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action,
      targetType: "OverlayLayout",
      targetId: aspect,
      after: { templateKey: key, widgetCount: widgets.length, version: version + 1 },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, layout: await currentLayout(tx, ctx.sellerId, aspect) };
  });
}

// 템플릿으로 초기화. templateKey: 기본 템플릿 키 또는 내 템플릿 id.
export async function resetLayout(db: PrismaClient, ctx: TenantContext, input: { aspect: unknown; template: unknown; expectedVersion: unknown }, meta: Meta = {}) {
  requireSellerPermission(ctx, "OVERLAY_EDIT");
  const aspect = parseAspect(input.aspect);
  const expected = input.expectedVersion;
  if (!aspect || typeof input.template !== "string" || typeof expected !== "number" || !Number.isInteger(expected) || expected < 0) return { ok: false as const, reason: "invalid_layout" as const };
  const builtin = BUILTIN_TEMPLATES[input.template];
  let widgets: Widget[] | null = builtin ? builtin.layouts[aspect] : null;
  if (!widgets && /^[0-9a-f-]{36}$/i.test(input.template)) {
    const mine = await db.overlayTemplate.findFirst({ where: { id: input.template, sellerId: ctx.sellerId, aspect }, select: { widgets: true } });
    widgets = mine ? (mine.widgets as Widget[]) : null;
  }
  if (!widgets) return { ok: false as const, reason: "template_not_found" as const };
  return writeLayout(db, ctx, aspect, widgets, expected, input.template, "overlay.layout.reset", meta);
}

export async function listTemplates(db: PrismaClient, ctx: TenantContext, aspect: Aspect) {
  requireSellerRead(ctx, "OVERLAY_EDIT");
  const mine = await db.overlayTemplate.findMany({ where: { sellerId: ctx.sellerId, aspect }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, name: true, widgets: true, createdAt: true } });
  return {
    builtin: Object.entries(BUILTIN_TEMPLATES).map(([key, t]) => ({ key, name: t.name, widgets: t.layouts[aspect] })),
    mine,
  };
}

export async function createTemplate(db: PrismaClient, ctx: TenantContext, input: { name: unknown; aspect: unknown; widgets: unknown }, meta: Meta = {}) {
  requireSellerPermission(ctx, "OVERLAY_EDIT");
  const aspect = parseAspect(input.aspect);
  const name = cleanText(input.name, 30, "memo");
  const widgets = parseWidgets(input.widgets);
  if (!aspect || !name || !widgets) return { ok: false as const, reason: "invalid_template" as const };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`overlay_template:${ctx.sellerId}`}))`;
    if ((await tx.overlayTemplate.count({ where: { sellerId: ctx.sellerId } })) >= MAX_TEMPLATES) return { ok: false as const, reason: "too_many_templates" as const };
    const t = await tx.overlayTemplate.create({ data: { sellerId: ctx.sellerId, name, aspect, widgets: widgets as unknown as Prisma.InputJsonValue }, select: { id: true, name: true, widgets: true, createdAt: true } });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "overlay.template.create", targetType: "OverlayTemplate", targetId: t.id, after: { name, aspect }, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: true as const, template: { ...t, aspect } };
  });
}

export async function deleteTemplate(db: PrismaClient, ctx: TenantContext, id: string, meta: Meta = {}) {
  requireSellerPermission(ctx, "OVERLAY_EDIT");
  return db.$transaction(async (tx) => {
    const t = await tx.overlayTemplate.findFirst({ where: { id, sellerId: ctx.sellerId }, select: { id: true, name: true } });
    if (!t) return false;
    await tx.overlayTemplate.delete({ where: { id } });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "overlay.template.delete", targetType: "OverlayTemplate", targetId: id, before: { name: t.name }, ip: meta.ip, userAgent: meta.userAgent });
    return true;
  });
}
