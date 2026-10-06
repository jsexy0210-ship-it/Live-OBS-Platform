import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as actionDoneRoute } from "../../app/api/automation/jobs/[jobId]/action-done/route";
import { AUTOMATION_LIMITS } from "../../lib/server/automation/config";
import { CUSTOMER_ACTION_ORDER, DEFAULT_RUN_MINUTES, getJob, listJobs, markCustomerActionDone, resumeJob } from "../../lib/server/automation/jobs";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-152: 「대기 중」 순번·예상 시작과 「고객 확인 필요」 할 일 목록 줄별 완료 표시
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

let n = 0;
async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, ctx, cookie: `lo_seller=${r.token}` };
}
const job = (sellerId: string, data: Record<string, unknown> = {}) =>
  db.automationJob.create({ data: { sellerId, kind: "RECONNECT_FREE", status: "QUEUED", obsTargetKey: `k-${++n}`, queuedAt: new Date(), ...data } as never });

// 판매자당 열린 작업은 하나뿐이다(DB 규칙)라서 다른 작업은 다른 판매자로 만든다
const other = async (data: Record<string, unknown> = {}) => (await job((await shop()).seller.id, data)).id;

describe("대기 순번·예상 시작", () => {
  it("앞선 대기 작업 수와 예상 분을 주고, 멈춘·실행 시작한 작업은 앞서지 않는다. 목록 조회에서는 계산하지 않는다", async () => {
    const s = await shop();
    const t0 = Date.now();
    const at = (i: number) => new Date(t0 - (10 - i) * 1000);
    await other({ runAfter: at(1), createdAt: at(1) });
    await other({ runAfter: at(2), createdAt: at(2) });
    await other({ runAfter: at(3), createdAt: at(3), pausedAt: new Date() }); // 멈춘 작업은 앞서지 않는다
    await other({ runAfter: at(4), createdAt: at(4), startedAt: new Date() }); // 이미 시작한 작업도 아니다
    const me = await job(s.seller.id, { runAfter: at(5), createdAt: at(5) });
    await other({ runAfter: at(8), createdAt: at(8) }); // 뒤 순서
    // 앞에 2개: 동시 실행 maxRunning씩 묶음, 성공 기록이 없으면 기본 길이
    const q = (await getJob(db, s.ctx, me.id)).queue!;
    expect(q.ahead).toBe(2);
    expect(q.etaMinutes).toBe(Math.ceil((Math.floor(2 / AUTOMATION_LIMITS.maxRunning) + 1) * DEFAULT_RUN_MINUTES));
    expect((await listJobs(db, s.ctx)).every((j) => j.queue === null)).toBe(true);
  });

  it("맨 앞이면 앞선 작업 0·예상 0분이고, 멈춘·시작한 작업 자신은 순번이 없다", async () => {
    const a = await shop();
    const first = await job(a.seller.id);
    expect((await getJob(db, a.ctx, first.id)).queue).toEqual({ ahead: 0, etaMinutes: 0 });
    const b = await shop();
    const paused = await job(b.seller.id, { pausedAt: new Date() });
    expect((await getJob(db, b.ctx, paused.id)).queue).toBeNull();
    const c = await shop();
    const started = await job(c.seller.id, { startedAt: new Date() });
    expect((await getJob(db, c.ctx, started.id)).queue).toBeNull();
  });

  it("최근 성공한 작업의 실행 시간 중앙값으로 예상 분을 어림한다", async () => {
    for (const min of [4, 6, 8]) await other({ status: "SUCCEEDED", finishedAt: new Date(), startedAt: new Date(), activeMsUsed: min * 60_000 });
    const t0 = Date.now();
    await other({ runAfter: new Date(t0 - 5000), createdAt: new Date(t0 - 5000) });
    const s = await shop();
    const me = await job(s.seller.id, { runAfter: new Date(t0), createdAt: new Date(t0) });
    expect((await getJob(db, s.ctx, me.id)).queue).toEqual({ ahead: 1, etaMinutes: 6 });
  });
});

describe("고객 확인 할 일 목록 줄별 완료", () => {
  const needs = (sellerId: string) => job(sellerId, { status: "NEEDS_CUSTOMER", customerAction: "TWO_FACTOR", actionDeadlineAt: new Date(Date.now() + 3600_000), startedAt: new Date() });
  const call = async (cookie: string, id: string, body: unknown) => {
    const r = await actionDoneRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ jobId: id }) });
    return { status: r.status, body: await r.json() };
  };

  it("고객 확인 대기에서만 5줄을 주고, 표시한 줄이 done으로 보이며 같은 줄을 다시 눌러도 그대로다", async () => {
    const s = await shop();
    const j = await needs(s.seller.id);
    const v = await getJob(db, s.ctx, j.id);
    expect(v.customerChecklist.map((c) => c.action)).toEqual([...CUSTOMER_ACTION_ORDER]);
    expect(v.customerChecklist.filter((c) => c.current).map((c) => c.action)).toEqual(["TWO_FACTOR"]);
    expect(v.customerChecklist.every((c) => !c.done)).toBe(true);
    const r1 = await call(s.cookie, j.id, { action: "LOGIN" });
    expect(r1.status).toBe(200);
    expect((await call(s.cookie, j.id, { action: "LOGIN" })).status).toBe(200);
    const r3 = await call(s.cookie, j.id, { action: "CAPTCHA" });
    expect(r3.body.customerChecklist.filter((c: { done: boolean }) => c.done).map((c: { action: string }) => c.action)).toEqual(["LOGIN", "CAPTCHA"]);
    expect((await db.automationJob.findUniqueOrThrow({ where: { id: j.id } })).customerActionsDone).toEqual(["LOGIN", "CAPTCHA"]);
    expect(await db.auditLog.count({ where: { action: "automation.action_done", targetId: j.id } })).toBe(2);
  });

  it("모르는 줄은 400, 고객 확인 대기가 아니면 409·빈 목록, 다른 판매자는 404, 직원 권한 없음은 403", async () => {
    const s = await shop();
    const stranger = await shop();
    const j = await needs(s.seller.id);
    expect((await call(s.cookie, j.id, { action: "NOPE" })).status).toBe(400);
    expect((await call(s.cookie, j.id, {})).status).toBe(400);
    expect((await call(stranger.cookie, j.id, { action: "LOGIN" })).status).toBe(404);
    const staff = await createSellerUser(s.seller.id, { permissions: [] });
    const sr = await loginSeller(db, { email: staff.email, password: PASSWORD }, {});
    if (!sr.ok) throw new Error(sr.reason);
    expect((await call(`lo_seller=${sr.token}`, j.id, { action: "LOGIN" })).status).toBe(403);
    await db.automationJob.update({ where: { id: j.id }, data: { status: "QUEUED", customerAction: null, actionDeadlineAt: null } });
    expect((await call(s.cookie, j.id, { action: "LOGIN" })).status).toBe(409);
    expect((await getJob(db, s.ctx, j.id)).customerChecklist).toEqual([]);
  });

  it("이어서 진행하기(재개)로 대기열에 돌아가면 표시를 비운다", async () => {
    const s = await shop();
    const j = await needs(s.seller.id);
    await markCustomerActionDone(db, s.ctx, j.id, "LOGIN");
    expect((await resumeJob(db, s.ctx, j.id)).ok).toBe(true);
    const after = await db.automationJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(after).toMatchObject({ status: "QUEUED", customerAction: null, customerActionsDone: [] });
    expect((await getJob(db, s.ctx, j.id)).customerChecklist).toEqual([]);
  });
});
