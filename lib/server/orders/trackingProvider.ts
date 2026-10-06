// 택배사 배송 조회 포트(배송 자동조회). 건당 외부 비용이 드는 기능이라 판매자가 켠 경우에만 부르고 발송·이용 충전금에서 차감한다(docs/COST_POLICY.md).
// 실제 업체(마스터 관리자 「외부 서비스 연동」에서 고른 배송 조회 업체)는 아직 붙지 않았다: 운영에는 어댑터가 없어 deliveryTrackingProvider()가 null이고,
// null이면 조회도 차감도 하지 않는다(택배사 조회 링크가 기본). 시험은 FakeDeliveryTrackingProvider를 쓴다.
export type TrackingLookup = { ok: true; status: "IN_TRANSIT" | "DELIVERED" | "UNKNOWN" } | { ok: false; reason: string };

export interface DeliveryTrackingProvider {
  readonly name: string;
  lookup(input: { courier: string; trackingNumber: string }): Promise<TrackingLookup>;
}

export class FakeDeliveryTrackingProvider implements DeliveryTrackingProvider {
  readonly name = "fake";
  readonly calls: { courier: string; trackingNumber: string }[] = [];
  // 송장 번호별 결과(없으면 배송 중). 함수로 바꾸면 호출마다 정할 수 있다.
  results = new Map<string, TrackingLookup>();
  failNext: "error" | "throw" | null = null;

  async lookup(input: { courier: string; trackingNumber: string }): Promise<TrackingLookup> {
    this.calls.push(input);
    const f = this.failNext;
    this.failNext = null;
    if (f === "throw") throw new Error("carrier_down");
    if (f === "error") return { ok: false, reason: "carrier_error" };
    return this.results.get(input.trackingNumber) ?? { ok: true, status: "IN_TRANSIT" };
  }
}

const g = globalThis as unknown as { deliveryTrackingOverride?: DeliveryTrackingProvider | null };

// 정기 실행이 쓰는 조회 공급자. 실제 어댑터가 생기기 전까지 null(돈이 움직이는 경로를 열지 않음).
export function deliveryTrackingProvider(): DeliveryTrackingProvider | null {
  return g.deliveryTrackingOverride ?? null;
}

// 시험용
export function setDeliveryTrackingProviderForTest(p: DeliveryTrackingProvider | null | undefined) {
  g.deliveryTrackingOverride = p;
}
