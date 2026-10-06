import { randomInt } from "node:crypto";
import type { InvoiceEventKind } from "@prisma/client";

// 송장 발급·추적 포트(SA-027·028). 배송 접수 업체는 아직 정해지지 않아 운영에는 모의 어댑터만 있다(MockInvoiceProvider).
// 실제 택배사·접수 업체 연동, 건당 과금(발송·이용 충전금 차감), 업체 계약은 대표님 승인 뒤: 어댑터를 InvoiceProvider로 구현해 invoiceProvider()에서 돌려주면 된다.
// 모의 송장은 주문 상태·배송 레코드·구매자 안내를 바꾸지 않는다(가짜 송장번호가 구매자에게 나가면 안 되므로). 실제 어댑터가 붙을 때 출력 시점에 발송 처리(shipOrder)를 잇는다.
export type InvoiceRecipient = { name: string; phone: string; zipCode: string; address1: string; address2: string | null };
export type IssueInput = { courier: string; sellerId: string; invoiceId: string; orderIds: string[]; recipient: InvoiceRecipient };
export type IssueResult = { ok: true; trackingNumber: string } | { ok: false; reason: string };
export type TrackEvent = { kind: Extract<InvoiceEventKind, "PICKED_UP" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED">; at: Date; note: string | null };
export type TrackInput = { courier: string; trackingNumber: string; printedAt: Date | null };

export interface InvoiceProvider {
  readonly name: string;
  // true면 모의 데이터(화면이 「업체 연동 전 · 모의」를 보여 준다)
  readonly mock: boolean;
  issue(input: IssueInput): Promise<IssueResult>;
  // 출력한 송장의 택배사 이벤트(집하 이후). 출력 전 송장은 집하되지 않으므로 빈 목록이다.
  track(input: TrackInput, now: Date): Promise<TrackEvent[]>;
  requestPickup(input: { courier: string; trackingNumber: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

const HOUR = 3_600_000;
// 모의 추적: 출력 시각 기준으로 집하(+2시간) → 간선 이동(+8) → 배송 출발(+20) → 배송 완료(+30)
const TIMELINE: { kind: TrackEvent["kind"]; afterHours: number; note: string }[] = [
  { kind: "PICKED_UP", afterHours: 2, note: "집하" },
  { kind: "IN_TRANSIT", afterHours: 8, note: "간선 이동" },
  { kind: "OUT_FOR_DELIVERY", afterHours: 20, note: "배송 출발" },
  { kind: "DELIVERED", afterHours: 30, note: "배송 완료" },
];

export class MockInvoiceProvider implements InvoiceProvider {
  readonly name = "mock";
  readonly mock = true;
  // 12자리 숫자(예: 5600 1234 5678 형식). 같은 번호가 겹치면 DB 유니크가 막고 다시 만든다.
  async issue(_input?: IssueInput): Promise<IssueResult> {
    return { ok: true, trackingNumber: `56${String(randomInt(0, 10_000_000_000)).padStart(10, "0")}` };
  }
  async track(input: TrackInput, now: Date): Promise<TrackEvent[]> {
    if (!input.printedAt) return [];
    return TIMELINE.map((t) => ({ kind: t.kind, at: new Date(input.printedAt!.getTime() + t.afterHours * HOUR), note: t.note })).filter((e) => e.at <= now);
  }
  async requestPickup(_input?: { courier: string; trackingNumber: string }) {
    return { ok: true as const };
  }
}

// 시험용: 호출 기록·실패 주입·추적 이벤트 지정
export class FakeInvoiceProvider extends MockInvoiceProvider {
  readonly issued: IssueInput[] = [];
  pickups: { courier: string; trackingNumber: string }[] = [];
  // 다음 발급 몇 건을 실패시킨다(번호 앞 두 글자 대신 순번이 필요하면 results로)
  failIssue: string[] = [];
  events = new Map<string, TrackEvent[]>();
  override async issue(input: IssueInput): Promise<IssueResult> {
    this.issued.push(input);
    const f = this.failIssue.shift();
    return f ? { ok: false, reason: f } : super.issue(input);
  }
  override async track(input: TrackInput, now: Date): Promise<TrackEvent[]> {
    return this.events.get(input.trackingNumber) ?? super.track(input, now);
  }
  override async requestPickup(input: { courier: string; trackingNumber: string }) {
    this.pickups.push(input);
    return { ok: true as const };
  }
}

const g = globalThis as unknown as { invoiceProviderOverride?: InvoiceProvider | null };
const mock = new MockInvoiceProvider();

export function invoiceProvider(): InvoiceProvider {
  return g.invoiceProviderOverride ?? mock;
}

// 시험용
export function setInvoiceProviderForTest(p: InvoiceProvider | null | undefined) {
  g.invoiceProviderOverride = p;
}
