import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as publicLayout } from "../../app/api/overlay/[token]/layout/route";
import { POST as resetRoute } from "../../app/api/seller/overlay/layout/reset/route";
import { GET as layoutGet, PUT as layoutPut } from "../../app/api/seller/overlay/layout/route";
import { DELETE as templateDelete } from "../../app/api/seller/overlay/templates/[templateId]/route";
import { GET as templatesGet, POST as templatesPost } from "../../app/api/seller/overlay/templates/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { ASPECTS, BUILTIN_TEMPLATES, BUILTIN_WIDGET_TYPES, DEFAULT_TEMPLATE, MAX_TEMPLATES, WIDGET_TYPES, parseWidgets } from "../../lib/server/overlay/layout";
import { issueOverlayToken } from "../../lib/server/overlay/token";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 오버레이 레이아웃 API(SA-051 편집기 → OV-001·002)
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const U = "http://localhost:3000/api/seller/overlay";

async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, owner, ctx, cookie: `lo_seller=${r.token}` };
}
const get = (cookie: string, aspect = "9x16") => layoutGet(new Request(`${U}/layout?aspect=${aspect}`, { headers: { ...H, cookie } }));
const put = (cookie: string, body: unknown) => layoutPut(new Request(`${U}/layout`, { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
const reset = (cookie: string, body: unknown) => resetRoute(new Request(`${U}/layout/reset`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }));
const tplList = (cookie: string, aspect = "9x16") => templatesGet(new Request(`${U}/templates?aspect=${aspect}`, { headers: { ...H, cookie } }));
const tplCreate = (cookie: string, body: unknown) => templatesPost(new Request(`${U}/templates`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }));
const tplDelete = (cookie: string, id: string) => templateDelete(new Request(`${U}/templates/${id}`, { method: "DELETE", headers: { ...H, cookie } }), { params: Promise.resolve({ templateId: id }) });
const pub = (token: string, qs = "") => publicLayout(new Request(`http://localhost:3000/api/overlay/${token}/layout${qs}`), { params: Promise.resolve({ token }) });

const widget = (over: Record<string, unknown> = {}) => ({ id: "current", type: "CURRENT_ORDER", visible: true, x: 3, y: 2, w: 94, h: 10, z: 3, props: { glow: true, accentColor: "#FF8800", titleBgOpacity: 0.9, appear: "flip", appearSec: 0.7 }, ...over });

describe("기본 템플릿", () => {
  it("비율마다 3종이고 모두 검사를 통과한다. 7종 위젯을 하나씩, 화면 안에 둔다", () => {
    expect(Object.keys(BUILTIN_TEMPLATES)).toEqual(["queue_focus", "spotlight", "minimal"]);
    expect(Object.values(BUILTIN_TEMPLATES).map((t) => t.name)).toEqual(["줄서기형", "스포트라이트형", "미니형"]);
    expect(DEFAULT_TEMPLATE).toBe("queue_focus");
    for (const t of Object.values(BUILTIN_TEMPLATES)) {
      for (const aspect of ASPECTS) {
        const ws = t.layouts[aspect];
        expect(parseWidgets(ws)).toEqual(ws);
        expect(ws.map((w) => w.type).sort()).toEqual([...BUILTIN_WIDGET_TYPES].sort());
        expect(ws.every((w) => w.x + w.w <= 100 && w.y + w.h <= 100)).toBe(true);
        expect(ws.every((w) => w.props.radius === 16 && w.props.flowSec === 20 && w.props.appear === "up")).toBe(true);
      }
    }
  });

  it("신규 주문 알림은 공지 자리·맨 위(z9)·첫 주문·6초, 시작 타이머는 기본 숨김이고 나머지는 보인다", () => {
    for (const t of Object.values(BUILTIN_TEMPLATES)) {
      for (const aspect of ASPECTS) {
        const ws = t.layouts[aspect];
        const notice = ws.find((w) => w.type === "NOTICE")!;
        const alert = ws.find((w) => w.type === "NEW_ORDER_ALERT")!;
        expect([alert.x, alert.y, alert.w, alert.h]).toEqual([notice.x, notice.y, notice.w, notice.h]);
        expect(alert).toMatchObject({ z: 9, visible: true, props: { variant: "first", durationSec: 6 } });
        expect(Math.max(...ws.filter((w) => w !== alert).map((w) => w.z))).toBeLessThan(9);
        expect(ws.filter((w) => !w.visible).map((w) => w.type)).toEqual(["OPEN_TIMER"]);
      }
    }
  });

  it("줄서기형 세로는 디자인 수치표 그대로", () => {
    const rect = (type: string) => {
      const w = BUILTIN_TEMPLATES.queue_focus.layouts["9x16"].find((v) => v.type === type)!;
      return [w.x, w.y, w.w, w.h, w.z];
    };
    expect(rect("HALL_OF_FAME")).toEqual([56.7, 23.4, 38.9, 19.9, 2]);
    expect(rect("CURRENT_ORDER")).toEqual([4.4, 23.4, 50.7, 10.8, 3]);
    expect(rect("QUEUE")).toEqual([4.4, 34.9, 50.7, 8.4, 2]);
    expect(rect("OPEN_TIMER")).toEqual([56.7, 43.9, 38.9, 4, 5]);
    expect(rect("NEW_ORDER_ALERT")).toEqual([4.4, 18, 91.2, 4.8, 9]);
  });
});

describe("레이아웃 저장·조회", () => {
  it("저장한 적 없으면 기본 템플릿(version 0), 저장하면 version이 오르고 오버레이 주소로도 같은 위젯을 준다. 비율은 따로", async () => {
    const s = await shop();
    const g = await get(s.cookie);
    expect(g.status).toBe(200);
    expect(await g.json()).toMatchObject({ aspect: "9x16", templateKey: "queue_focus", version: 0, isDefault: true, widgets: BUILTIN_TEMPLATES.queue_focus.layouts["9x16"] });
    const r = await put(s.cookie, { aspect: "9x16", widgets: [widget()], expectedVersion: 0 });
    expect(r.status).toBe(200);
    const saved = await r.json();
    expect(saved).toMatchObject({ version: 1, isDefault: false, widgets: [{ id: "current", props: { accentColor: "#ff8800", glow: true } }] });
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "overlay.layout.update", sellerId: s.seller.id } })).toMatchObject({ actorId: s.owner.id, targetId: "9x16", after: { widgetCount: 1, version: 1 } });
    expect((await (await get(s.cookie, "16x9")).json()).version).toBe(0);

    const token = await issueOverlayToken(db, s.ctx);
    const p = await pub(token);
    expect(p.status).toBe(200);
    expect(await p.json()).toEqual({ aspect: "9x16", version: 1, widgets: saved.widgets });
    expect((await (await pub(token, "?aspect=16x9")).json()).version).toBe(0);
    expect((await pub(token, "?aspect=4x3")).status).toBe(400);
    // 재발급하면 옛 주소는 404
    await issueOverlayToken(db, s.ctx);
    expect((await pub(token)).status).toBe(404);
  });

  it("다른 창에서 먼저 저장했으면 409(지금 version), 동시에 두 번 저장해도 하나만 된다", async () => {
    const s = await shop();
    expect((await put(s.cookie, { aspect: "9x16", widgets: [widget()], expectedVersion: 0 })).status).toBe(200);
    const stale = await put(s.cookie, { aspect: "9x16", widgets: [widget({ x: 1 })], expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "version_conflict", currentVersion: 1 });
    const both = await Promise.all([1, 2].map((x) => put(s.cookie, { aspect: "9x16", widgets: [widget({ x })], expectedVersion: 1 })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db.overlayLayout.findUniqueOrThrow({ where: { sellerId_aspect: { sellerId: s.seller.id, aspect: "9x16" } } })).version).toBe(2);
  });

  it("이벤트 할인 카드·구매 랭킹 위젯: 종류마다 하나, 구매 랭킹만 줄 수(1~10)", () => {
    const w = (type: string, props: Record<string, unknown> = {}, id = type.toLowerCase()) => ({ id, type, visible: true, x: 0, y: 0, w: 10, h: 10, z: 1, props });
    expect(parseWidgets([w("EVENT_CARD", { title: "이벤트" }), w("PURCHASE_RANKING", { rows: 10 })])?.map((x) => x.type)).toEqual(["EVENT_CARD", "PURCHASE_RANKING"]);
    for (const bad of [
      [w("PURCHASE_RANKING", { rows: 11 })],
      [w("PURCHASE_RANKING", { rows: 0 })],
      [w("EVENT_CARD", { rows: 3 })],
      [w("EVENT_CARD"), w("EVENT_CARD", {}, "event_card2")],
      [w("PURCHASE_RANKING"), w("PURCHASE_RANKING", {}, "ranking2")],
    ]) expect(parseWidgets(bad)).toBeNull();
  });

  it("허용하지 않는 위젯·속성·값은 저장하지 않는다(400)", async () => {
    const s = await shop();
    const alert = (variant: string, id = `alert_${variant}`) => ({ id, type: "NEW_ORDER_ALERT", visible: true, x: 0, y: 0, w: 10, h: 10, z: 1, props: { variant } });
    const bad: unknown[] = [
      [widget({ type: "LOGO" })],
      [widget({ props: { onclick: "x" } })],
      [widget({ props: { accentColor: "red" } })],
      [widget({ props: { appear: "spin" } })],
      [widget({ props: { fontWeight: 450 } })],
      [widget({ props: { title: "줄\u0000바꿈" } })],
      [widget({ x: 50, w: 51 })],
      [widget({ w: 0 })],
      [widget({ z: 100 })],
      [widget({ extra: 1 })],
      [widget(), widget()],
      [widget(), widget({ id: "current2" })],
      [alert("first"), alert("first", "alert_dup")],
      [alert("loud")],
      Array.from({ length: 21 }, (_, i) => widget({ id: `w${i}`, type: "NOTICE" })),
      "nope",
    ];
    for (const widgets of bad) {
      const r = await put(s.cookie, { aspect: "9x16", widgets, expectedVersion: 0 });
      expect(r.status, JSON.stringify(widgets).slice(0, 80)).toBe(400);
    }
    expect((await put(s.cookie, { aspect: "4x3", widgets: [widget()], expectedVersion: 0 })).status).toBe(400);
    expect((await put(s.cookie, { aspect: "9x16", widgets: [widget()], expectedVersion: "0" })).status).toBe(400);
    // 신규 주문 알림은 첫 주문·재주문·VIP 각각, 공지 문구는 여러 줄
    const ok = await put(s.cookie, {
      aspect: "9x16",
      widgets: [alert("first"), alert("repeat"), alert("vip"), { id: "notice", type: "NOTICE", visible: true, x: 0, y: 30, w: 100, h: 10, z: 0, props: { text: "오늘 8시 방송\n신규 팩 입고" } }],
      expectedVersion: 0,
    });
    expect(ok.status).toBe(200);
    expect(await db.overlayLayout.count()).toBe(1);
  });
});

describe("템플릿", () => {
  it("기본 템플릿·내 템플릿으로 초기화하고, 내 템플릿은 20개까지·삭제는 내 것만", async () => {
    const s = await shop();
    const other = await shop();
    const r1 = await reset(s.cookie, { aspect: "16x9", template: "spotlight", expectedVersion: 0 });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ templateKey: "spotlight", version: 1, widgets: BUILTIN_TEMPLATES.spotlight.layouts["16x9"] });
    expect((await reset(s.cookie, { aspect: "16x9", template: "nope", expectedVersion: 1 })).status).toBe(404);

    const c = await tplCreate(s.cookie, { name: "내 방송용", aspect: "16x9", widgets: [widget({ x: 2, w: 30 })] });
    expect(c.status).toBe(201);
    const mine = await c.json();
    const list = await (await tplList(s.cookie, "16x9")).json();
    expect(list.builtin.map((t: { key: string }) => t.key)).toEqual(["queue_focus", "spotlight", "minimal"]);
    expect(list.mine).toMatchObject([{ id: mine.id, name: "내 방송용" }]);
    expect((await (await tplList(s.cookie, "9x16")).json()).mine).toEqual([]);
    const r2 = await reset(s.cookie, { aspect: "16x9", template: mine.id, expectedVersion: 1 });
    expect(await r2.json()).toMatchObject({ templateKey: mine.id, version: 2, widgets: [{ x: 2, w: 30 }] });
    // 다른 쇼핑몰은 내 템플릿을 쓰거나 지울 수 없다
    expect((await reset(other.cookie, { aspect: "16x9", template: mine.id, expectedVersion: 0 })).status).toBe(404);
    expect((await tplDelete(other.cookie, mine.id)).status).toBe(404);
    expect((await tplCreate(s.cookie, { name: "", aspect: "16x9", widgets: [] })).status).toBe(400);
    expect((await tplCreate(s.cookie, { name: "x", aspect: "16x9", widgets: [widget({ type: "LOGO" })] })).status).toBe(400);

    for (let i = 1; i < MAX_TEMPLATES; i++) expect((await tplCreate(s.cookie, { name: `t${i}`, aspect: "9x16", widgets: [] })).status).toBe(201);
    const full = await tplCreate(s.cookie, { name: "over", aspect: "9x16", widgets: [] });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: "too_many_templates" });
    expect((await tplDelete(s.cookie, mine.id)).status).toBe(200);
    expect((await tplDelete(s.cookie, mine.id)).status).toBe(404);
    expect(await db.auditLog.count({ where: { action: { in: ["overlay.layout.reset", "overlay.template.create", "overlay.template.delete"] }, sellerId: s.seller.id } })).toBe(2 + MAX_TEMPLATES + 1);
  });
});

describe("권한·격리", () => {
  it("오버레이 편집 권한 없는 직원은 조회·저장·템플릿 모두 403, 다른 쇼핑몰 레이아웃은 바뀌지 않는다", async () => {
    const s = await shop();
    const other = await shop();
    const staff = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    const r = await loginSeller(db, { email: staff.email, password: PASSWORD }, {});
    if (!r.ok) throw new Error();
    const cookie = `lo_seller=${r.token}`;
    expect((await get(cookie)).status).toBe(403);
    expect((await put(cookie, { aspect: "9x16", widgets: [widget()], expectedVersion: 0 })).status).toBe(403);
    expect((await tplList(cookie)).status).toBe(403);
    expect((await tplCreate(cookie, { name: "x", aspect: "9x16", widgets: [] })).status).toBe(403);
    const editor = await createSellerUser(s.seller.id, { permissions: ["OVERLAY_EDIT"] });
    const er = await loginSeller(db, { email: editor.email, password: PASSWORD }, {});
    if (!er.ok) throw new Error();
    expect((await put(`lo_seller=${er.token}`, { aspect: "9x16", widgets: [widget()], expectedVersion: 0 })).status).toBe(200);
    expect((await (await get(other.cookie)).json()).version).toBe(0);
  });
});

describe("방송 중 오버레이 레이아웃 기록(SA-054)", () => {
  it("LIVE 방송이 있으면 처음 요청한 레이아웃만 방송에 남기고, 방송이 없거나 이미 있으면 바꾸지 않는다", async () => {
    const s = await shop();
    const token = await issueOverlayToken(db, s.ctx);
    // 방송이 없을 때 요청은 아무것도 만들지 않는다
    expect((await pub(token, "?aspect=16x9")).status).toBe(200);
    expect(await db.broadcastSession.count({ where: { sellerId: s.seller.id } })).toBe(0);
    const live = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    expect((await pub(token, "?aspect=16x9")).status).toBe(200);
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: live.id } })).layoutAspect).toBe("16x9");
    expect((await pub(token, "?aspect=9x16")).status).toBe(200);
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: live.id } })).layoutAspect).toBe("16x9");
    // 잘못된 aspect는 기록하지 않는다
    const live2 = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "ENDED" } });
    expect((await pub(token, "?aspect=4x3")).status).toBe(400);
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: live2.id } })).layoutAspect).toBeNull();
  });
});
