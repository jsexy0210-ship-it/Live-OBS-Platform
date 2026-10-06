import type { AutomationJob, AutomationPayment, Seller, SellerSubscription, SubscriptionPayment, SubscriptionPlan } from "@prisma/client";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { sellerAccess } from "../billing/access";
import { planFeatures } from "../billing/features";
import { AUTOMATION_PRICE } from "../automation/config";
import { actionKeyOf } from "../automation/engine";
import { isJobId } from "../automation/ids";
import type { AutomationAction } from "../automation/ports";
import { validateDecision } from "../automation/ports";
import { STEPS } from "../automation/steps";

// 서버 명령 경계. 지속 기기 인증 reader/영속 저널/OBS transport는 아직 구현하지 않는다.
// reader는 인증된 서버 저장소 전용이다. HTTP 본문/클라이언트 plan·paid 값으로 구현하면 안 된다.
export type ObsServerRecords = {
  seller: Pick<Seller, "id" | "status" | "trialEndsAt">;
  planCode: SubscriptionPlan["code"];
  subscription: Pick<SellerSubscription, "sellerId" | "status" | "currentPeriodEnd" | "nextChargeAt" | "graceUntil" | "cancelAtPeriodEnd"> | null;
  firstPayment: Pick<SubscriptionPayment, "sellerId" | "status"> | null;
  device: { sellerId: string; id: string; pairingId: string; generation: number; epoch: number; revokedAt: Date | null; expiresAt: Date };
  install: {
    payment: Pick<AutomationPayment, "id" | "sellerId" | "status" | "amount" | "paidAt">;
    job: Pick<AutomationJob, "id" | "sellerId" | "paymentId" | "kind" | "status" | "stepIndex" | "fencingToken" | "leaseExpiresAt" | "obsPairingId" | "cancelRequestedAt" | "connectionRevokedAt">;
  } | null;
  explicitInput: { id: string; sellerId: string; deviceId: string; actorId: string; kind: "start_stream" | "stop_stream"; at: Date } | null;
};
export interface ObsServerReader {
  read(sellerId: string, deviceId: string, installJobId?: string): Promise<ObsServerRecords | null>;
}
const issued = new WeakSet<object>();
const authorityBrand: unique symbol = Symbol("server-obs-authority");
export type ObsAuthority = {
  readonly [authorityBrand]: true;
  readonly sellerId: string;
  readonly deviceId: string;
  readonly pairingId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly validUntil: number;
  readonly jobId: string | null;
  readonly stepIndex: number;
  readonly jobFence: number | null;
  readonly explicitInput: Readonly<Omit<NonNullable<ObsServerRecords["explicitInput"]>, "at"> & { at: number }> | null;
};
function fail(code: string): never { throw new Error(code); }
const time = (date: Date | null): number => date instanceof Date ? date.getTime() : NaN;

// 기기 인증과 별개인 저장값 판정. DB reader와 명령 계약이 같은 구독·설치 기준을 사용한다.
export type ObsAccountRecords = Omit<ObsServerRecords, "device" | "explicitInput">;
export function obsAccountAccess(r: ObsAccountRecords, sellerId: string, now: Date) {
  if (r.seller.id !== sellerId || r.seller.status !== "ACTIVE" ||
    (r.subscription && r.subscription.sellerId !== sellerId) ||
    (r.firstPayment && r.firstPayment.sellerId !== sellerId)) fail("obs_access_denied");
  const features = planFeatures(r.planCode, { firstPaymentConfirmed: r.firstPayment?.status === "PAID", hadTrial: !!r.seller.trialEndsAt });
  const access = sellerAccess({ trialEndsAt: r.seller.trialEndsAt, subscription: r.subscription }, now);
  if (!features.includes("OVERLAY") || access === "expired") fail("obs_access_denied");
  return access;
}
export function obsInitialInstallValid(install: ObsAccountRecords["install"], sellerId: string, jobId: string, now: Date): boolean {
  if (!install) return false;
  const { payment: p, job: j } = install;
  return p.sellerId === sellerId && p.status === "PAID" && p.amount === AUTOMATION_PRICE && time(p.paidAt) <= time(now) &&
    j.id === jobId && j.sellerId === sellerId && j.paymentId === p.id && j.kind === "INITIAL" &&
    ["RUNNING", "VERIFYING"].includes(j.status) && !j.cancelRequestedAt && !j.connectionRevokedAt && time(j.leaseExpiresAt) > time(now);
}

export async function loadObsAuthority(ctx: TenantContext, reader: ObsServerReader, deviceId: string, now: Date, installJobId?: string): Promise<ObsAuthority> {
  requireSellerPermission(ctx, "OVERLAY_EDIT");
  if (installJobId && !isJobId(installJobId)) fail("obs_purchase_unverified");
  const r = await reader.read(ctx.sellerId, deviceId, installJobId);
  if (!r) fail("obs_access_denied");
  const access = obsAccountAccess(r, ctx.sellerId, now);
  const d = r.device;
  if (d.sellerId !== ctx.sellerId || d.id !== deviceId || !d.pairingId || d.revokedAt || !Number.isSafeInteger(d.generation) || d.generation < 1 || !Number.isSafeInteger(d.epoch) || d.epoch < 1 || !(time(d.expiresAt) > time(now))) fail("obs_device_denied");
  let jobId: string | null = null;
  let stepIndex = 0;
  let jobFence: number | null = null;
  let deadline = time(d.expiresAt);
  const accessEnd = access === "paid" ? r.subscription?.currentPeriodEnd : access === "trial" ? r.seller.trialEndsAt : access === "grace" ? r.subscription?.graceUntil : null;
  if (accessEnd) deadline = Math.min(deadline, time(accessEnd));
  if (r.planCode !== "INTEGRATED") {
    // 유료 설치의 현재 작업 위임만 검증한다. 완료 후 지속 권리/재설치 정책을 새로 결정하지 않는다.
    const install = r.install;
    if (r.planCode !== "OVERLAY_ONLY" || !ctx.isOwner || !install || !installJobId) fail("obs_purchase_required");
    const { job: j } = install;
    if (!obsInitialInstallValid(install, ctx.sellerId, installJobId, now) || !Number.isSafeInteger(j.fencingToken) || j.fencingToken < 1 || j.obsPairingId !== d.pairingId) fail("obs_purchase_unverified");
    jobId = j.id; stepIndex = j.stepIndex; jobFence = j.fencingToken; deadline = Math.min(deadline, time(j.leaseExpiresAt));
  }
  // 초안의 짧은 관측 수명. 실제 명령 직전 재조회·기기 fencing은 향후 reader/transport 책임이다.
  const explicit = r.explicitInput;
  const input = explicit && explicit.sellerId === ctx.sellerId && explicit.deviceId === deviceId && explicit.actorId === ctx.actorId && time(explicit.at) <= time(now) && time(now) - time(explicit.at) <= 30_000 ? Object.freeze({ ...explicit, at: time(explicit.at) }) : null;
  if (input) requireSellerPermission(ctx, "BROADCAST_RUN");
  const authority: ObsAuthority = Object.freeze({ [authorityBrand]: true as const, sellerId: ctx.sellerId, deviceId, pairingId: d.pairingId, generation: d.generation, epoch: d.epoch, validUntil: Math.min(deadline, time(now) + 30_000), jobId, stepIndex, jobFence, explicitInput: input });
  issued.add(authority);
  return authority;
}

type SetupAction = Extract<AutomationAction, { type: "obs_add_overlay_source" | "obs_apply_display_settings" | "check_overlay_shows_test_event" }>;
export type ObsCommand = {
  id: string; sellerId: string; deviceId: string; generation: number; epoch: number; jobFence?: number; expiresAt: Date;
  action: SetupAction | { type: "start_stream" | "stop_stream"; explicitInputId: string };
};
export type ObsPreparedCommand = Readonly<{ command: Readonly<Omit<ObsCommand, "expiresAt"> & { expiresAt: number }>; actionKey: string; pairingId: string; scope: { sellerId: string; jobId: string; jobFence: number | null } }>;
const preparedAuthorities = new WeakMap<object, ObsAuthority>();
export function prepareObsCommand(authority: ObsAuthority, command: ObsCommand, now: Date): ObsPreparedCommand {
  if (!issued.has(authority)) fail("obs_authority_unverified");
  if (command.sellerId !== authority.sellerId || command.deviceId !== authority.deviceId || command.generation !== authority.generation || command.epoch !== authority.epoch) fail("obs_scope_mismatch");
  if (!isJobId(command.id) || !(time(now) < authority.validUntil) || !(time(command.expiresAt) > time(now)) || time(command.expiresAt) > authority.validUntil) fail("obs_command_expired");
  const type = command.action.type;
  if (Object.keys(command.action).some(key => key !== "type" && !((type === "start_stream" || type === "stop_stream") && key === "explicitInputId"))) fail("obs_action_denied");
  if (command.jobFence !== undefined && command.jobFence !== authority.jobFence) fail("obs_scope_mismatch");
  const scope = { sellerId: authority.sellerId, jobId: authority.jobId ?? `basic:${authority.sellerId}:${authority.deviceId}:${authority.generation}:${command.id}`, jobFence: authority.jobFence };
  if (type === "start_stream" || type === "stop_stream") {
    const input = authority.explicitInput;
    if (authority.jobId || !input || input.kind !== type || input.id !== command.action.explicitInputId || time(now) - input.at > 30_000) fail("obs_explicit_input_required");
  } else if (!["obs_add_overlay_source", "obs_apply_display_settings", "check_overlay_shows_test_event"].includes(type)) fail("obs_action_denied");
  if (authority.jobId) {
    const step = STEPS[authority.stepIndex];
    if (!step || !validateDecision(step, { action: command.action as SetupAction, costWon: 0 }, { webhook_url: "", webhook_secret: "" }).ok) fail("obs_install_step_mismatch");
  }
  // 현재 설치 단계의 정확한 행동 키를 재사용한다. 송출 transport는 이 초안에 없다.
  const actionKey = type === "start_stream" || type === "stop_stream" ? `${scope.jobId}:${type}:${command.action.explicitInputId}` : actionKeyOf(scope.jobId, authority.stepIndex, command.action as SetupAction);
  const copied = { id: command.id, sellerId: command.sellerId, deviceId: command.deviceId, generation: command.generation, epoch: command.epoch, ...(authority.jobFence !== null ? { jobFence: authority.jobFence } : {}), expiresAt: time(command.expiresAt), action: Object.freeze({ ...command.action }) };
  const prepared = Object.freeze({ command: Object.freeze(copied), actionKey, pairingId: authority.pairingId, scope: Object.freeze(scope) });
  preparedAuthorities.set(prepared, authority);
  return prepared;
}

export type ObsAck = { sellerId: string; deviceId: string; generation: number; epoch: number; jobFence?: number; actionKey: string; pairingId: string; result: "APPLIED" | "FAILED" };
export type ObsCommandState = "APPLIED" | "FAILED" | "UNKNOWN";
export function obsAckState(prepared: ObsPreparedCommand, ack: ObsAck | null): ObsCommandState {
  const c = prepared.command;
  return ack && ack.sellerId === c.sellerId && ack.deviceId === c.deviceId && ack.generation === c.generation && ack.epoch === c.epoch && (prepared.scope.jobFence === null || ack.jobFence === prepared.scope.jobFence) && ack.actionKey === prepared.actionKey && ack.pairingId === prepared.pairingId && ["APPLIED", "FAILED"].includes(ack.result) ? ack.result : "UNKNOWN";
}

// 한 프로세스의 모의 중복/ACK 경계만 검증한다. 영속 저널·재시작 복구 구현이 아니다.
export class ObsCommandMemory {
  private readonly calls = new Map<string, { fingerprint: string; result: Promise<ObsCommandState> }>();
  private readonly actions = new Map<string, { jobFence: number | null; result: Promise<ObsCommandState> }>();
  run(prepared: ObsPreparedCommand, send: (command: ObsPreparedCommand) => Promise<ObsAck | null>, now = new Date()): Promise<ObsCommandState> {
    const c = prepared.command;
    const authority = preparedAuthorities.get(prepared);
    if (!authority) fail("obs_authority_unverified");
    if (!(time(now) < authority.validUntil) || !(c.expiresAt > time(now)) || c.expiresAt > authority.validUntil) fail("obs_command_expired");
    // 설치 transport만 모의 실행한다. 명시 입력이 있어도 실송출 transport는 미구현이다.
    if (c.action.type === "start_stream" || c.action.type === "stop_stream") fail("obs_stream_transport_unimplemented");
    const key = `${c.sellerId}:${c.deviceId}:${c.generation}:${c.epoch}:${c.id}`;
    const fingerprint = JSON.stringify([prepared.actionKey, c.action, prepared.scope.jobFence]);
    const old = this.calls.get(key);
    if (old) {
      if (old.fingerprint !== fingerprint) fail("idempotency_key_reused");
      return old.result;
    }
    // send는 다음 microtask에서 시작해 동시 요청도 단 하나의 결과를 공유한다.
    const actionScope = `${c.sellerId}:${c.deviceId}:${c.generation}:${c.epoch}:${prepared.actionKey}`;
    const cached = this.actions.get(actionScope);
    // 이전 fence의 성공도 현재 ACK가 아니다. 행동은 재전송하지 않고 대사를 기다린다.
    const result = cached
      ? cached.jobFence === prepared.scope.jobFence ? cached.result : Promise.resolve("UNKNOWN" as const)
      : Promise.resolve().then(() => send(prepared)).then(ack => obsAckState(prepared, ack), () => "UNKNOWN" as const);
    if (!cached) this.actions.set(actionScope, { jobFence: prepared.scope.jobFence, result });
    this.calls.set(key, { fingerprint, result });
    return result;
  }
}
