import type { Prisma, PrismaClient } from "@prisma/client";

// 즉시 발송 배송비·배송지(PRODUCT_SCOPE MVP 「즉시 발송」).
// 배송비 = 기본 배송비(상품 합계가 무료 기준 이상이면 0) + 도서산간 추가비(무료 배송이어도 붙음).
// 판매자 정책이 없으면 기본값으로 계산한다. 적립 기준에는 배송비를 넣지 않는다(queue/service rewardBase).

export const INT4_MAX = 2147483647;
export const MAX_FEE = 100_000;
export const MAX_FREE_OVER = 100_000_000;
export const MAX_ZIP_RANGES = 50;

export type ZipRange = [number, number];
export type ShippingPolicy = { baseFee: number; freeOverAmount: number | null; remoteSurcharge: number; remoteZipRanges: ZipRange[] };

// 제주(63000~63644)·울릉(40200~40240). 판매자가 바꿀 수 있다.
export const DEFAULT_SHIPPING_POLICY: ShippingPolicy = {
  baseFee: 3000,
  freeOverAmount: null,
  remoteSurcharge: 3000,
  remoteZipRanges: [
    [63000, 63644],
    [40200, 40240],
  ],
};

// 판매자가 고를 수 있는 택배사. 화면에는 이름을 보여 주고 값은 코드로 받는다.
export const COURIERS = {
  CJ: "CJ대한통운",
  HANJIN: "한진택배",
  LOTTE: "롯데택배",
  LOGEN: "로젠택배",
  EPOST: "우체국택배",
} as const;
export type Courier = keyof typeof COURIERS;
export const isCourier = (v: unknown): v is Courier => typeof v === "string" && Object.prototype.hasOwnProperty.call(COURIERS, v);

const isFee = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

function parseZipRanges(raw: unknown): ZipRange[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ZIP_RANGES) return null;
  const out: ZipRange[] = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length !== 2) return null;
    const [from, to] = r;
    if (!isFee(from, 99999) || !isFee(to, 99999) || from > to) return null;
    out.push([from, to]);
  }
  return out;
}

// 판매자 정책 입력 검증. 잘못된 값은 null.
export function parseShippingPolicy(raw: unknown): ShippingPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (!isFee(b.baseFee, MAX_FEE) || !isFee(b.remoteSurcharge, MAX_FEE)) return null;
  const freeOverAmount = b.freeOverAmount ?? null;
  if (freeOverAmount !== null && (!isFee(freeOverAmount, MAX_FREE_OVER) || freeOverAmount < 1)) return null;
  const remoteZipRanges = parseZipRanges(b.remoteZipRanges);
  if (!remoteZipRanges) return null;
  return { baseFee: b.baseFee, freeOverAmount, remoteSurcharge: b.remoteSurcharge, remoteZipRanges };
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function getShippingPolicy(db: Db, sellerId: string): Promise<ShippingPolicy> {
  const p = await db.sellerShippingPolicy.findUnique({ where: { sellerId } });
  if (!p) return DEFAULT_SHIPPING_POLICY;
  return {
    baseFee: p.baseFee,
    freeOverAmount: p.freeOverAmount,
    remoteSurcharge: p.remoteSurcharge,
    // 저장 때 검증했지만, 깨진 값이면 기본 지역으로 계산한다
    remoteZipRanges: parseZipRanges(p.remoteZipRanges) ?? DEFAULT_SHIPPING_POLICY.remoteZipRanges,
  };
}

export function isRemoteZip(zipCode: string, ranges: readonly ZipRange[]): boolean {
  const zip = Number(zipCode);
  return ranges.some(([from, to]) => zip >= from && zip <= to);
}

export function computeShippingFee(itemsSubtotal: number, policy: ShippingPolicy, isRemote: boolean): number {
  const base = policy.freeOverAmount !== null && itemsSubtotal >= policy.freeOverAmount ? 0 : policy.baseFee;
  return base + (isRemote ? policy.remoteSurcharge : 0);
}

export type ShippingAddressInput = {
  recipientName: string;
  phone: string;
  zipCode: string;
  address1: string;
  address2: string | null;
  memo: string | null;
};

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
};
const optionalText = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  return text(v, max) ?? undefined;
};

// 받는 분·연락처(숫자만 저장)·우편번호(5자리)·주소. 잘못된 값은 null.
export function parseShippingAddress(raw: unknown): ShippingAddressInput | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const recipientName = text(b.recipientName, 30);
  const phone = typeof b.phone === "string" ? b.phone.replace(/[\s-]/g, "") : "";
  const zipCode = typeof b.zipCode === "string" ? b.zipCode.trim() : "";
  const address1 = text(b.address1, 200);
  const address2 = optionalText(b.address2, 100);
  const memo = optionalText(b.memo, 100);
  if (!recipientName || !address1 || address2 === undefined || memo === undefined) return null;
  if (!/^0\d{8,10}$/.test(phone) || !/^\d{5}$/.test(zipCode)) return null;
  return { recipientName, phone, zipCode, address1, address2, memo };
}
