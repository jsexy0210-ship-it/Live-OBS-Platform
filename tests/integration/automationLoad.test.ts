import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as orderRoute } from "../../app/api/shop/[slug]/orders/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { FakeBrowserExecutor, FakeObsBridge, FakePlanner, FakeSecretVault } from "../../lib/server/automation/fakes";
import { cafe24Playbook } from "../../lib/server/automation/playbooks/cafe24";
import { runOnce } from "../../lib/server/automation/worker";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

// 모의 부하: 자동 연결 작업 10 → 50 → 100개를 작업자 10개가 도는 동안 주문 API 지연을 잰다.
// 작업은 연결 작업서로 실행하고, 판단·브라우저·로컬 도구는 가짜(행동마다 5ms 지연)다. 실제 외부 호출 지연·CPU는 반영하지 않는다(docs/AUTOMATION.md 7절).
// 지연 값은 실행 환경마다 달라 단언하지 않고 출력만 한다. 단언은 정확성(모두 1번씩 완료, 주문 모두 성공)만.

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const WORKERS = 10;
const MAX_RUNNING = 20;
const ACTION_DELAY_MS = 5;
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const shippingAddress = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "서울 강남구 테헤란로 1", address2: "101호" };

// 구매자 1명은 1분에 주문 10건까지라(ORDER_RATE_LIMIT) 9건마다 다음 구매자로 바꾼다. 구매자 준비는 시간 측정 밖에서 한다.
async function orderShop() {
  const { seller, grade } = await createSeller();
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1팩", stock: 1_000_000 } });
  let used = 9;
  let cookie = "";
  const nextCookie = async () => {
    if (used >= 9) {
      const buyer = await createLoginBuyer(seller.id, grade.id);
      const r = await loginBuyer(db, { sellerId: seller.id, loginId: buyer.loginId, password: PASSWORD }, {});
      if (!r.ok) throw new Error(r.reason);
      cookie = `lo_buyer=${r.token}`;
      used = 0;
    }
    used++;
    return cookie;
  };
  return { slug: seller.slug, optionId: option.id, nextCookie };
}

async function timedOrder(s: Awaited<ReturnType<typeof orderShop>>): Promise<{ ms: number; status: number }> {
  const cookie = await s.nextCookie();
  const t = performance.now();
  const res = await orderRoute(
    new Request(`http://localhost:3000/api/shop/${s.slug}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", cookie },
      body: JSON.stringify({ items: [{ optionId: s.optionId, quantity: 1 }], consent, shippingAddress }),
    }),
    { params: Promise.resolve({ slug: s.slug }) },
  );
  return { ms: performance.now() - t, status: res.status };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
};

// 결제가 확인된(PAID) 작업을 바로 대기열에 넣는다. 자동 연결 테이블은 Seller에 외래키가 없어 임의 판매자 id로 만든다.
async function seedQueued(n: number) {
  for (let i = 0; i < n; i++) {
    const sellerId = randomUUID();
    const p = await db.automationPayment.create({ data: { sellerId, amount: 110000, idempotencyKey: `load-${i}`, requestFingerprint: "load", consentNoticeVersion: "load", consentAgreedAt: new Date(), status: "PAID", paidAt: new Date() } });
    await db.automationJob.create({
      data: { sellerId, paymentId: p.id, status: "QUEUED", obsTargetKey: `seller:${sellerId}`, playbookId: cafe24Playbook.id, playbookVersion: cafe24Playbook.version },
    });
  }
}

describe("자동 연결 모의 부하와 주문 API 지연", () => {
  it(
    "동시 10 → 50 → 100 작업: 모두 1번씩 완료되고, 그동안 주문은 모두 성공한다(지연 측정값 출력)",
    async () => {
      const shop = await orderShop();
      for (let i = 0; i < 5; i++) await timedOrder(shop); // 준비 운동(첫 호출 컴파일·연결 비용 제외)
      const base: number[] = [];
      for (let i = 0; i < 40; i++) base.push((await timedOrder(shop)).ms);
      const rows: string[] = [`기준(부하 없음) 주문 ${base.length}건: p50 ${pct(base, 50)}ms, p95 ${pct(base, 95)}ms, 최대 ${pct(base, 100)}ms`];

      for (const n of [10, 50, 100]) {
        await db.automationJobEvent.deleteMany();
        await db.automationJob.deleteMany();
        await db.automationPayment.deleteMany();
        await seedQueued(n);
        const rt = { planner: new FakePlanner(), browser: new FakeBrowserExecutor(ACTION_DELAY_MS), obs: new FakeObsBridge(ACTION_DELAY_MS), vault: new FakeSecretVault() };
        // 작업서 화면 단서와 맞는 관리 화면(시험용 쇼핑몰 흉내)
        rt.browser.pageText = () => "앱 설치 · 설치 완료 · 주문 알림 · 저장";
        let peakRunning = 0;
        let done = false;
        const t0 = performance.now();
        const worker = async (w: number) => {
          for (;;) {
            const r = await runOnce(db, rt, { workerId: `w${w}`, maxRunning: MAX_RUNNING });
            if (r === "idle") {
              const left = await db.automationJob.count({ where: { status: { in: ["QUEUED", "RUNNING", "VERIFYING"] } } });
              if (left === 0) return;
              await new Promise((res) => setTimeout(res, 10));
            }
          }
        };
        const sampler = (async () => {
          while (!done) {
            peakRunning = Math.max(peakRunning, await db.automationJob.count({ where: { status: { in: ["RUNNING", "VERIFYING"] } } }));
            await new Promise((res) => setTimeout(res, 20));
          }
        })();
        const orders: { ms: number; status: number }[] = [];
        const orderLoop = (async () => {
          while (!done || orders.length < 40) orders.push(await timedOrder(shop));
        })();
        await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));
        const elapsed = performance.now() - t0;
        done = true;
        await Promise.all([orderLoop, sampler]);

        expect(await db.automationJob.count({ where: { status: "SUCCEEDED" } })).toBe(n);
        expect(await db.automationJobEvent.count({ where: { toStatus: "SUCCEEDED" } })).toBe(n);
        expect(peakRunning).toBeLessThanOrEqual(MAX_RUNNING);
        expect(rt.browser.live.size).toBe(0);
        expect(orders.filter((o) => o.status !== 200).map((o) => o.status)).toEqual([]);
        const ms = orders.map((o) => o.ms);
        rows.push(
          `작업 ${n}개(작업자 ${WORKERS}, 동시 상한 ${MAX_RUNNING}): 전체 ${Math.round(elapsed)}ms, 처리량 ${Math.round((n / elapsed) * 10000) / 10}건/초, 최대 동시 실행 ${peakRunning} | ` +
            `주문 ${ms.length}건: p50 ${pct(ms, 50)}ms, p95 ${pct(ms, 95)}ms, 최대 ${pct(ms, 100)}ms`,
        );
      }
      console.log(`\n[자동 연결 모의 부하]\n${rows.join("\n")}\n`);
    },
    180_000,
  );
});
