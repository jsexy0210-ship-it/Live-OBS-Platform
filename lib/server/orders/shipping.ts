import type { Prisma, PrismaClient } from "@prisma/client";
import { cleanText, textLength, type TextKind } from "../text/clean";

// 즉시 발송 배송비·배송지(PRODUCT_SCOPE MVP 「즉시 발송」).
// 배송비 = 기본 배송비(상품 합계가 무료 기준 이상이면 0) + 도서산간 추가비(무료 배송이어도 붙음).
// 판매자 정책이 없으면 기본값으로 계산한다. 적립 기준에는 배송비를 넣지 않는다(queue/service rewardBase).

export const INT4_MAX = 2147483647;
export const MAX_FEE = 100_000;
export const MAX_FREE_OVER = 100_000_000;
export const MAX_ZIP_RANGES = 50;

export type ZipRange = [number, number];
// freeShipping: 무료(0원) 배송 유형. 켜면 기본 배송비·무료 기준을 쓰지 않고, 도서산간 추가비는 그대로 붙는다(대표님 결정 2026-10-03).
export type ShippingPolicy = { freeShipping: boolean; baseFee: number; freeOverAmount: number | null; remoteSurcharge: number; remoteZipRanges: ZipRange[] };

// 제주(63000~63644)·울릉(40200~40240). 판매자가 바꿀 수 있다.
export const DEFAULT_SHIPPING_POLICY: ShippingPolicy = {
  freeShipping: false,
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
  // 무료 배송 유형은 빼고 보내면 꺼짐(유료)
  const freeShipping = b.freeShipping ?? false;
  if (typeof freeShipping !== "boolean") return null;
  return { freeShipping, baseFee: b.baseFee, freeOverAmount, remoteSurcharge: b.remoteSurcharge, remoteZipRanges };
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function getShippingPolicy(db: Db, sellerId: string): Promise<ShippingPolicy> {
  const p = await db.sellerShippingPolicy.findUnique({ where: { sellerId } });
  if (!p) return DEFAULT_SHIPPING_POLICY;
  return {
    freeShipping: p.freeShipping,
    baseFee: p.baseFee,
    freeOverAmount: p.freeOverAmount,
    remoteSurcharge: p.remoteSurcharge,
    // 저장 때 검증했지만, 깨진 값이면 기본 지역으로 계산한다
    remoteZipRanges: parseZipRanges(p.remoteZipRanges) ?? DEFAULT_SHIPPING_POLICY.remoteZipRanges,
  };
}

// 도서산간 판정. 우편번호와 주소가 어긋나도 추가비가 빠지지 않게 둘 중 하나라도 맞으면 도서산간으로 본다.
// 주소는 NFKC 정규화 후 공백을 모두 지운 문자열에 행정구역 이름이 들어 있는지 본다(「경상북도울릉군」처럼 붙여 써도 잡힘).
// 「제주로」·「울릉길」 같은 도로명은 이 이름과 달라 빠진다. 「제주도로」처럼 잘못 잡히는 경우는 추가비가 붙는 쪽이라 허용한다.
const REMOTE_REGION_NAMES = ["제주특별자치도", "제주도", "제주시", "서귀포시", "울릉군", "울릉도"] as const;
// 영문 주소는 토큰으로 본다(「Jeju-ro」 같은 도로명은 맞지 않음)
const REMOTE_LATIN_TOKEN = /^(jeju|seogwipo|ulleung)(-?(do|si|gun|island))?$/i;

export function isRemoteAddress(zipCode: string, address1: string, ranges: readonly ZipRange[]): boolean {
  const zip = Number(zipCode);
  if (ranges.some(([from, to]) => zip >= from && zip <= to)) return true;
  const n = address1.normalize("NFKC");
  const compact = n.replace(/\s+/g, "");
  if (REMOTE_REGION_NAMES.some((name) => compact.includes(name))) return true;
  return n.split(/[^\p{L}\p{N}-]+/u).some((t) => REMOTE_LATIN_TOKEN.test(t));
}

export function computeShippingFee(itemsSubtotal: number, policy: ShippingPolicy, isRemote: boolean): number {
  const base = policy.freeShipping || (policy.freeOverAmount !== null && itemsSubtotal >= policy.freeOverAmount) ? 0 : policy.baseFee;
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

const optionalText = (v: unknown, max: number, kind: TextKind = "name"): string | null | undefined => {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  return cleanText(v, max, kind) ?? undefined;
};

// 받는 분·주소: 쓸 수 없는 글자를 먼저 검사하고, 연속 공백을 하나로 줄인 뒤(같은 배송지 판정·송장 출력) 그 값으로 길이를 잰다.
const spacedText = (v: unknown, max: number): string | null => {
  const t = cleanText(v, Number.MAX_SAFE_INTEGER);
  if (!t) return null;
  const one = t.replace(/\s+/g, " ");
  return textLength(one) <= max ? one : null;
};
const optionalSpaced = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  return spacedText(v, max) ?? undefined;
};

// 받는 분·연락처(숫자만 저장)·우편번호(5자리)·주소. 잘못된 값은 null.
export function parseShippingAddress(raw: unknown): ShippingAddressInput | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const recipientName = spacedText(b.recipientName, 30);
  // 전각 숫자·하이픈도 받도록 NFKC 정규화 뒤 검사한다
  const phone = typeof b.phone === "string" ? b.phone.normalize("NFKC").replace(/[ -]/g, "") : "";
  const zipCode = typeof b.zipCode === "string" ? b.zipCode.normalize("NFKC").trim() : "";
  const address1 = spacedText(b.address1, 200);
  const address2 = optionalSpaced(b.address2, 100);
  const memo = optionalText(b.memo, 100, "memo");
  if (!recipientName || !address1 || address2 === undefined || memo === undefined) return null;
  if (!/^0\d{8,10}$/.test(phone) || !/^\d{5}$/.test(zipCode)) return null;
  return { recipientName, phone, zipCode, address1, address2, memo };
}
