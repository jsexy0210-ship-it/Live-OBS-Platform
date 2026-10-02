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

// 도서산간 판정. 우편번호와 주소가 어긋나도 추가비가 빠지지 않게 둘 중 하나라도 맞으면 도서산간으로 본다.
// 주소는 첫 행정구역(시·도, 시·군) 토큰으로 본다. 「서울 강남구 제주로」처럼 도로명에 든 지명은 해당하지 않는다.
const REMOTE_REGION_TOKENS = new Set(["제주", "제주도", "제주특별자치도", "제주시", "서귀포", "서귀포시", "울릉", "울릉군", "울릉도"]);
// 울릉 앞에 오는 도 이름, 앞에 붙는 나라 이름은 건너뛴다
const SKIP_LEADING_TOKENS = new Set(["대한민국", "한국", "경상북도", "경북"]);
// 영문 주소는 순서가 반대라 어느 자리에 있든 행정구역 토큰이면 본다(「Jeju-ro」 같은 도로명은 맞지 않음)
const REMOTE_LATIN_TOKEN = /^(jeju|seogwipo|ulleung)(-?(do|si|gun|island))?$/i;

export function isRemoteAddress(zipCode: string, address1: string, ranges: readonly ZipRange[]): boolean {
  const zip = Number(zipCode);
  if (ranges.some(([from, to]) => zip >= from && zip <= to)) return true;
  const tokens = address1
    .normalize("NFKC")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .split(/[^\p{L}\p{N}-]+/u)
    .filter(Boolean);
  if (tokens.some((t) => REMOTE_LATIN_TOKEN.test(t))) return true;
  const first = tokens.find((t) => !SKIP_LEADING_TOKENS.has(t) && !/^\d+$/.test(t));
  return first !== undefined && REMOTE_REGION_TOKENS.has(first);
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

// NFKC로 정규화한 뒤 제어문자(NUL·줄바꿈·탭), 보이지 않는 서식 문자(방향 바꿈·폭 없는 공백 등), 줄·문단 구분 문자는 받지 않는다
// (DB 오류·송장 출력 깨짐·표시 위장 방지). 전각 공백·NBSP는 정규화에서 일반 공백이 되어 허용된다.
const DISALLOWED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const n = v.normalize("NFKC");
  if (DISALLOWED.test(n)) return null;
  const t = n.trim();
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
  const phone = typeof b.phone === "string" ? b.phone.replace(/[ -]/g, "") : "";
  const zipCode = typeof b.zipCode === "string" ? b.zipCode.trim() : "";
  const address1 = text(b.address1, 200);
  const address2 = optionalText(b.address2, 100);
  const memo = optionalText(b.memo, 100);
  if (!recipientName || !address1 || address2 === undefined || memo === undefined) return null;
  if (!/^0\d{8,10}$/.test(phone) || !/^\d{5}$/.test(zipCode)) return null;
  return { recipientName, phone, zipCode, address1, address2, memo };
}
