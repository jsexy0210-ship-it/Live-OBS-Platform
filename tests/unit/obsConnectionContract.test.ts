import { describe, expect, it, vi } from "vitest";
import { loadObsAuthority, prepareObsCommand, obsAckState, ObsCommandMemory, type ObsAck, type ObsAuthority, type ObsCommand, type ObsPreparedCommand, type ObsServerRecords } from "../../lib/server/obs/contract";
import { FakeObsBridge } from "../../lib/server/automation/fakes";
import { actionKeyOf, callPort } from "../../lib/server/automation/engine";
import { AUTOMATION_PRICE } from "../../lib/server/automation/config";
import type { TenantContext } from "../../lib/server/tenant/context";

const now = new Date("2026-10-07T00:00:00Z");
const future = (ms = 60_000) => new Date(now.getTime() + ms);
const jobId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const ctx: TenantContext = { sellerId: "seller-a", actorId: "owner-a", actorType: "SELLER_USER", isOwner: true, readOnly: false, permissions: [] };
const records = (): ObsServerRecords => ({
  seller: { id: ctx.sellerId, status: "ACTIVE", trialEndsAt: null }, planCode: "INTEGRATED",
  subscription: { sellerId: ctx.sellerId, status: "ACTIVE", currentPeriodEnd: future(), nextChargeAt: null, graceUntil: null, cancelAtPeriodEnd: false },
  firstPayment: { sellerId: ctx.sellerId, status: "PAID" },
  device: { sellerId: ctx.sellerId, id: "device-a", pairingId: "pc-seller-a", generation: 1, epoch: 3, revokedAt: null, expiresAt: future() },
  install: null, explicitInput: null,
});
const paid = (): ObsServerRecords => ({ ...records(), planCode: "OVERLAY_ONLY", install: {
  payment: { id: "payment-a", sellerId: ctx.sellerId, status: "PAID", amount: AUTOMATION_PRICE, paidAt: now },
  job: { id: jobId, sellerId: ctx.sellerId, paymentId: "payment-a", kind: "INITIAL", status: "RUNNING", stepIndex: 2, fencingToken: 3, leaseExpiresAt: future(), obsPairingId: "pc-seller-a", cancelRequestedAt: null, connectionRevokedAt: null },
} });
const command = (overrides: Partial<ObsCommand> = {}): ObsCommand => ({ id, sellerId: ctx.sellerId, deviceId: "device-a", generation: 1, epoch: 3, expiresAt: future(10_000), action: { type: "obs_add_overlay_source" }, ...overrides });
const load = (r = records(), actor = ctx) => loadObsAuthority(actor, { read: vi.fn(async () => r) }, "device-a", now, r.install?.job.id);
const ack = (p: ObsPreparedCommand): ObsAck => ({ sellerId: p.command.sellerId, deviceId: p.command.deviceId, generation: p.command.generation, epoch: p.command.epoch, ...(p.scope.jobFence !== null ? { jobFence: p.scope.jobFence } : {}), actionKey: p.actionKey, pairingId: p.pairingId, result: "APPLIED" });
const fakeSend = (bridge: FakeObsBridge) => async (p: ObsPreparedCommand): Promise<ObsAck | null> => {
  const response = await callPort(signal => bridge.perform(p.scope, p.command.action as { type: "obs_add_overlay_source" }, p.actionKey, p.pairingId, signal));
  return response.ok && response.value.kind === "ok" ? { ...ack(p), pairingId: response.value.pairingId! } : null;
};

describe("서버 근거와 구독별 OBS 계약 (모의 경계, 실제 인증·PC 연결 아님)", () => {
  it("기기 epoch와 job fence는 독립이며 이전 job ACK는 UNKNOWN이다", async () => {
    const r = paid(); r.install!.job.fencingToken = 99;
    const authority = await load(r);
    expect(authority.epoch).toBe(3); expect(authority.jobFence).toBe(99);
    const p = prepareObsCommand(authority, command(), now);
    expect(p.command.jobFence).toBe(99);
    expect(obsAckState(p, { ...ack(p), jobFence: 3 })).toBe("UNKNOWN");
    expect(obsAckState(p, { ...ack(p), jobFence: undefined })).toBe("UNKNOWN");
    expect(obsAckState(p, ack(p))).toBe("APPLIED");
    expect(() => prepareObsCommand(authority, command({ jobFence: 3 }), now)).toThrow("obs_scope_mismatch");
  });
  it("새 job fence도 UNKNOWN 행동을 무조건 재실행하지 않는다", async () => {
    const memory = new ObsCommandMemory(); const send = vi.fn(async () => null);
    const first = prepareObsCommand(await load(paid()), command(), now);
    expect(await memory.run(first, send, now)).toBe("UNKNOWN");
    const r = paid(); r.install!.job.fencingToken = 99;
    const next = prepareObsCommand(await load(r), command({ id: "33333333-3333-4333-8333-333333333333" }), now);
    expect(next.actionKey).toBe(first.actionKey);
    expect(await memory.run(next, send, now)).toBe("UNKNOWN"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("같은 actionKey의 이전 APPLIED를 새 commandId/fence에서 성공으로 재사용하지 않는다", async () => {
    const memory = new ObsCommandMemory(); const send = vi.fn(async (p: ObsPreparedCommand) => ack(p));
    const first = prepareObsCommand(await load(paid()), command(), now);
    expect(await memory.run(first, send, now)).toBe("APPLIED");
    const r = paid(); r.install!.job.fencingToken = 4;
    const next = prepareObsCommand(await load(r), command({ id: "33333333-3333-4333-8333-333333333333" }), now);
    expect(next.actionKey).toBe(first.actionKey);
    expect(obsAckState(next, ack(first))).toBe("UNKNOWN");
    expect(await memory.run(next, send, now)).toBe("UNKNOWN");
    expect(await memory.run(next, send, now)).toBe("UNKNOWN");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("통합은 실제 첫 PAID 근거로 허용, 오버레이만으로는 자동 연결을 열지 않는다", async () => {
    expect((await load()).jobId).toBeNull();
    await expect(load({ ...records(), planCode: "OVERLAY_ONLY" })).rejects.toThrow("obs_purchase_required");
    await expect(load({ ...records(), firstPayment: null })).rejects.toThrow("obs_access_denied");
  });
  it.each(["PENDING", "FAILED", "REFUND_PENDING", "REFUNDED"] as const)("자동 설치 결제 %s로 실행 권한을 발급하지 않는다", async status => {
    const r = paid(); r.install!.payment.status = status;
    await expect(load(r)).rejects.toThrow("obs_purchase_unverified");
  });
  it("PAID 110,000원 초기 설치의 서버 작업·대상·lease·단계를 재사용한다", async () => {
    const a = await load(paid());
    const p = prepareObsCommand(a, command(), now);
    expect(p.actionKey).toBe(actionKeyOf(jobId, 2, { type: "obs_add_overlay_source" }));
    const r = paid(); r.install!.job.stepIndex = 0;
    expect(() => prepareObsCommand({ ...a } as ObsAuthority, command(), now)).toThrow("obs_authority_unverified");
    expect(() => prepareObsCommand(a, command({ action: { type: "check_overlay_shows_test_event" } }), now)).toThrow("obs_install_step_mismatch");
    expect(() => prepareObsCommand(a, command({ action: { type: "start_stream", explicitInputId: "input" } }), now)).toThrow("obs_explicit_input_required");
    expect(() => prepareObsCommand(a, command({ action: { type: "obs_add_overlay_source", paid: true } } as unknown as Partial<ObsCommand>), now)).toThrow("obs_action_denied");
    expect(() => prepareObsCommand({ paid: true, plan: "INTEGRATED" } as unknown as ObsAuthority, command(), now)).toThrow("obs_authority_unverified");
    expect(() => prepareObsCommand(a, command(), future(30_000))).toThrow("obs_command_expired");
    const wrongStep = await load(r);
    expect(() => prepareObsCommand(wrongStep, command(), now)).toThrow("obs_install_step_mismatch");
  });
  it.each(["CANCELED", "FAILED", "SUCCEEDED", "QUEUED"] as const)("현재 설치 위임이 아닌 작업 %s는 신규 설치를 실행하지 않는다", async status => {
    const r = paid(); r.install!.job.status = status;
    await expect(load(r)).rejects.toThrow("obs_purchase_unverified");
  });
  it("금액·판매자·결제 연결·PC·fencing·취소·권한회수·lease 반례를 거부한다", async () => {
    const mutations: ((r: ObsServerRecords) => void)[] = [
      r => { r.install!.payment.amount = 1; }, r => { r.install!.payment.paidAt = null; },
      r => { r.install!.payment.sellerId = "seller-b"; }, r => { r.install!.job.paymentId = "other"; },
      r => { r.install!.job.obsPairingId = "pc-other"; }, r => { r.install!.job.fencingToken = 0; },
      r => { r.install!.job.cancelRequestedAt = now; }, r => { r.install!.job.connectionRevokedAt = now; },
      r => { r.install!.job.leaseExpiresAt = now; },
    ];
    for (const change of mutations) { const r = paid(); change(r); await expect(load(r)).rejects.toThrow("obs_purchase_unverified"); }
  });
  it("세션 tenant와 기기 소유자·generation을 대조하며 대리 조회/무권한 직원은 쓰기를 못 한다", async () => {
    await expect(load(records(), { ...ctx, readOnly: true })).rejects.toThrow();
    await expect(load(records(), { ...ctx, isOwner: false })).rejects.toThrow();
    expect((await load(records(), { ...ctx, isOwner: false, permissions: ["OVERLAY_EDIT"] })).sellerId).toBe(ctx.sellerId);
    for (const change of [(r: ObsServerRecords) => { r.device.sellerId = "seller-b"; }, (r: ObsServerRecords) => { r.device.revokedAt = now; }, (r: ObsServerRecords) => { r.device.generation = 0; }]) {
      const r = records(); change(r); await expect(load(r)).rejects.toThrow("obs_device_denied");
    }
    const a = await load();
    for (const patch of [{ sellerId: "seller-b" }, { deviceId: "device-b" }, { generation: 2 }, { epoch: 4 }]) expect(() => prepareObsCommand(a, command(patch), now)).toThrow("obs_scope_mismatch");
  });
  it("명시적인 현재 사용자 송출 입력을 요구하며 이 초안에서는 실제 송출 transport를 실행하지 않는다", async () => {
    const stream = command({ action: { type: "start_stream", explicitInputId: "input-a" } });
    const a = await load();
    expect(() => prepareObsCommand(a, stream, now)).toThrow("obs_explicit_input_required");
    const r = records(); r.explicitInput = { id: "input-a", sellerId: ctx.sellerId, deviceId: "device-a", actorId: ctx.actorId, kind: "start_stream", at: now };
    const explicit = await load(r);
    const p = prepareObsCommand(explicit, stream, now);
    const send = vi.fn();
    expect(() => new ObsCommandMemory().run(p, send, now)).toThrow("obs_stream_transport_unimplemented");
    expect(send).not.toHaveBeenCalled();
    expect(() => prepareObsCommand(explicit, command({ action: { type: "stop_stream", explicitInputId: "input-a" } }), now)).toThrow("obs_explicit_input_required");
    r.explicitInput.at = new Date(now.getTime() - 30_001);
    expect(() => prepareObsCommand(explicit, stream, future(30_001))).toThrow("obs_command_expired");
    const stale = await load(r);
    expect(() => prepareObsCommand(stale, stream, now)).toThrow("obs_explicit_input_required");
    r.explicitInput.at = now; r.explicitInput.actorId = "other";
    const otherActor = await load(r);
    expect(() => prepareObsCommand(otherActor, stream, now)).toThrow("obs_explicit_input_required");
  });
});

describe("FakeObsBridge 재사용 명령·ACK 경계 (영속 저널 아님)", () => {
  it("같은 명령 동시 호출은 소스 한 번만 설치하고 원래 결과를 공유한다", async () => {
    const p = prepareObsCommand(await load(), command(), now);
    const bridge = new FakeObsBridge(); const send = vi.fn(fakeSend(bridge)); const memory = new ObsCommandMemory();
    expect(await Promise.all([memory.run(p, send, now), memory.run(p, send, now)])).toEqual(["APPLIED", "APPLIED"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(bridge.sources.get(ctx.sellerId)).toBe(1);
    const changed = prepareObsCommand(await load(), command({ action: { type: "obs_apply_display_settings" } }), now);
    expect(() => memory.run(changed, send, now)).toThrow("idempotency_key_reused");
  });
  it("다른 commandId로 재전송해도 기존 유료 작업 exact actionKey는 한 번 적용한다", async () => {
    const a = await load(paid());
    const first = prepareObsCommand(a, command(), now);
    const second = prepareObsCommand(a, command({ id: "33333333-3333-4333-8333-333333333333" }), now);
    const bridge = new FakeObsBridge(); const send = vi.fn(fakeSend(bridge)); const memory = new ObsCommandMemory();
    await Promise.all([memory.run(first, send, now), memory.run(second, send, now)]);
    expect(first.actionKey).toBe(second.actionKey);
    expect(send).toHaveBeenCalledTimes(1); expect(bridge.sources.get(ctx.sellerId)).toBe(1);
  });
  it("적용 뒤 ACK 유실은 UNKNOWN이며 자동 재실행하지 않는다", async () => {
    const p = prepareObsCommand(await load(), command(), now);
    const bridge = new FakeObsBridge(); const memory = new ObsCommandMemory();
    const lost = vi.fn(async (prepared: ObsPreparedCommand) => { await fakeSend(bridge)(prepared); return null; });
    expect(await memory.run(p, lost, now)).toBe("UNKNOWN");
    expect(await memory.run(p, lost, now)).toBe("UNKNOWN");
    expect(lost).toHaveBeenCalledTimes(1); expect(bridge.sources.get(ctx.sellerId)).toBe(1);
    // 별도 관측 ACK의 분류만 확인한다. 영속 재시작/실표시 복구 완료가 아니다.
    expect(obsAckState(p, ack(p))).toBe("APPLIED");
  });
  it("다른 판매자/기기/generation/epoch/키/PC의 ACK는 성공으로 오인하지 않는다", async () => {
    const p = prepareObsCommand(await load(), command(), now);
    for (const patch of [{ sellerId: "seller-b" }, { deviceId: "other" }, { generation: 2 }, { epoch: 4 }, { actionKey: "wrong" }, { pairingId: "other" }]) expect(obsAckState(p, { ...ack(p), ...patch })).toBe("UNKNOWN");
    expect(obsAckState(p, { ...ack(p), result: "FAILED" })).toBe("FAILED");
  });
  it("PC가 수행 직전에 바뀌면 기존 FakeObsBridge가 변경을 거부한다", async () => {
    const p = prepareObsCommand(await load(), command(), now); const bridge = new FakeObsBridge();
    bridge.pairing.set(ctx.sellerId, "pc-other");
    expect(await new ObsCommandMemory().run(p, fakeSend(bridge), now)).toBe("UNKNOWN");
    expect(bridge.performed).toHaveLength(0);
  });
  it("권한/명령 만료·위조 prepared를 수행 전에 막고 원본 Date 변경을 격리한다", async () => {
    const input = command(); const p = prepareObsCommand(await load(), input, now); const send = vi.fn();
    input.expiresAt.setTime(future().getTime());
    expect(p.command.expiresAt).toBe(future(10_000).getTime());
    const memory = new ObsCommandMemory();
    expect(() => memory.run(p, send, future(10_000))).toThrow("obs_command_expired");
    expect(() => memory.run({ ...p }, send, now)).toThrow("obs_authority_unverified");
    expect(send).not.toHaveBeenCalled();
  });
  it("구독/기기/lease의 짧은 만료를 권한 관측 수명으로 늘리지 않는다", async () => {
    const r = records(); r.subscription!.currentPeriodEnd = future(5_000);
    const a = await load(r);
    expect(a.validUntil).toBe(future(5_000).getTime());
    expect(() => prepareObsCommand(a, command(), now)).toThrow("obs_command_expired");
    const install = paid(); install.install!.job.leaseExpiresAt = future(5_000);
    expect((await load(install)).validUntil).toBe(future(5_000).getTime());
    const device = records(); device.device.expiresAt = future(3_000);
    expect((await load(device)).validUntil).toBe(future(3_000).getTime());
  });
  it("다른 판매자의 같은 commandId는 영향을 주지 않는다", async () => {
    const r = records(); r.seller.id = r.device.sellerId = r.subscription!.sellerId = r.firstPayment!.sellerId = "seller-b";
    r.device.pairingId = "pc-seller-b";
    const other = await load(r, { ...ctx, sellerId: "seller-b", actorId: "owner-b" });
    const p = prepareObsCommand(await load(), command(), now);
    const q = prepareObsCommand(other, command({ sellerId: "seller-b" }), now);
    const bridge = new FakeObsBridge(); const memory = new ObsCommandMemory();
    expect(await memory.run(p, fakeSend(bridge), now)).toBe("APPLIED");
    expect(await memory.run(q, fakeSend(bridge), now)).toBe("APPLIED");
    expect(bridge.sources.get("seller-a")).toBe(1); expect(bridge.sources.get("seller-b")).toBe(1);
  });
});
