import type { BuyerAddress, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { parseShippingAddress, type ShippingAddressInput } from "../orders/shipping";
import { cleanText } from "../text/clean";

// 구매자 저장 배송지(2026-10-03 대표님 결정, PRODUCT_SCOPE 「구매자 가입·배송지」).
// - 가입 때 받지 않고, 주문 때 입력한 배송지를 저장한다(구매자가 끌 수 있음). 마이페이지에서 추가·수정·삭제한다.
// - 구매자당 20개까지. 배송지가 있으면 기본 배송지는 항상 1개다. 처음 저장한 배송지가 기본이 되고, 기본에서 내리려면 다른 배송지를 기본으로 정한다.
// - 같은 배송지(받는 분·연락처·우편번호·주소·상세 주소가 같음)는 두 번 저장하지 않는다. 배송 메모와 배송지 이름(label)은 비교하지 않는다.
// - 주문에 쓰면 lastUsedAt을 갱신한다(같은 배송지로 다시 주문하면 사용 시각만 바뀜).
// - 기본 배송지를 지우면 남은 배송지 중 가장 최근에 사용한 것(쓴 적 없으면 최근 저장한 것)이 기본이 된다.
// - 같은 구매자의 배송지 변경은 구매자 단위 잠금 아래에서 한 줄로 처리한다(개수 한도·기본 배송지 경합 방지).

export const MAX_BUYER_ADDRESSES = 20;
export const MAX_ADDRESS_LABEL = 20;

export type AddressScope = { sellerId: string; buyerMemberId: string };
export type AddressFailure =
  | "invalid_shipping_address"
  | "invalid_address_label" // 보이지 않는 문자 등 쓸 수 없는 이름
  | "address_label_too_long"
  | "too_many_addresses"
  | "duplicate_address"
  | "address_not_found"
  | "default_address_required"; // 기본 배송지를 기본에서 내리려 함(다른 배송지를 기본으로 정해야 함)
export type AddressResult<T> = { ok: true; value: T } | { ok: false; reason: AddressFailure };

type Tx = Prisma.TransactionClient;
type Fields = ShippingAddressInput & { label: string | null };

export type AddressView = Pick<BuyerAddress, "id" | "label" | "recipientName" | "phone" | "zipCode" | "address1" | "address2" | "memo" | "isDefault" | "lastUsedAt" | "createdAt" | "updatedAt">;
const VIEW = { id: true, label: true, recipientName: true, phone: true, zipCode: true, address1: true, address2: true, memo: true, isDefault: true, lastUsedAt: true, createdAt: true, updatedAt: true } as const;
// 최근에 사용한 순(쓴 적 없으면 뒤로, 그 안에서는 최근 저장 순). 목록은 기본 배송지를 맨 앞에 둔다.
const RECENT: Prisma.BuyerAddressOrderByWithRelationInput[] = [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }];
const ORDER: Prisma.BuyerAddressOrderByWithRelationInput[] = [{ isDefault: "desc" }, ...RECENT];

const lockBuyerAddresses = (tx: Tx, s: AddressScope) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_address:${s.sellerId}:${s.buyerMemberId}`}))`;

// 이름(선택): 없거나 빈 값이면 null. 글자 수는 cleanText 기준(코드포인트)이고, 길기만 하면 too_long, 쓸 수 없는 글자면 invalid.
function parseLabel(v: unknown): string | null | "invalid_address_label" | "address_label_too_long" {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  const label = cleanText(v, MAX_ADDRESS_LABEL);
  if (label) return label;
  return cleanText(v, Number.MAX_SAFE_INTEGER) ? "address_label_too_long" : "invalid_address_label";
}

const sameAddress = (a: ShippingAddressInput) => ({
  recipientName: a.recipientName,
  phone: a.phone,
  zipCode: a.zipCode,
  address1: a.address1,
  address2: a.address2,
});

export async function listAddresses(db: PrismaClient, s: AddressScope): Promise<AddressView[]> {
  return db.buyerAddress.findMany({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId }, orderBy: ORDER, select: VIEW });
}

// 기본 배송지를 바꾼다(다른 기본 배송지를 먼저 내린다). 잠금 안에서만 부른다.
async function makeDefault(tx: Tx, s: AddressScope, id: string, now: Date) {
  await tx.buyerAddress.updateMany({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId, isDefault: true, id: { not: id } }, data: { isDefault: false, updatedAt: now } });
  await tx.buyerAddress.update({ where: { id }, data: { isDefault: true, updatedAt: now } });
}

// 저장 공통: 중복이면 기존 배송지, 한도를 넘으면 too_many. 처음 저장이면 기본 배송지가 된다.
// usedAt: 주문에 쓴 시각(마이페이지 추가는 null)
async function insert(tx: Tx, s: AddressScope, f: Fields, wantDefault: boolean, now: Date, usedAt: Date | null): Promise<{ created: boolean; address: AddressView } | "too_many_addresses"> {
  const existing = await tx.buyerAddress.findFirst({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId, ...sameAddress(f) }, select: VIEW });
  if (existing) return { created: false, address: existing };
  const count = await tx.buyerAddress.count({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId } });
  if (count >= MAX_BUYER_ADDRESSES) return "too_many_addresses";
  const a = await tx.buyerAddress.create({ data: { ...s, ...f, isDefault: false, lastUsedAt: usedAt, createdAt: now, updatedAt: now }, select: { id: true } });
  if (count === 0 || wantDefault) await makeDefault(tx, s, a.id, now);
  return { created: true, address: await tx.buyerAddress.findUniqueOrThrow({ where: { id: a.id }, select: VIEW }) };
}

function parseFields(raw: unknown): Fields | AddressFailure {
  const address = parseShippingAddress(raw);
  if (!address) return "invalid_shipping_address";
  const label = parseLabel((raw as Record<string, unknown>).label);
  if (label === "invalid_address_label" || label === "address_label_too_long") return label;
  return { ...address, label };
}

// 마이페이지에서 추가. 본문: { recipientName, phone, zipCode, address1, address2?, memo?, label?, isDefault? }
export async function createAddress(db: PrismaClient, s: AddressScope, raw: unknown): Promise<AddressResult<AddressView>> {
  const f = parseFields(raw);
  if (typeof f === "string") return { ok: false, reason: f };
  const isDefault = (raw as { isDefault?: unknown }).isDefault;
  if (isDefault !== undefined && typeof isDefault !== "boolean") return { ok: false, reason: "invalid_shipping_address" };
  const wantDefault = isDefault === true;
  return db.$transaction(async (tx) => {
    await lockBuyerAddresses(tx, s);
    const now = await dbNow(tx);
    const r = await insert(tx, s, f, wantDefault, now, null);
    if (r === "too_many_addresses") return { ok: false as const, reason: r };
    if (!r.created) return { ok: false as const, reason: "duplicate_address" as const };
    await writeAudit(tx, { actorType: "BUYER", actorId: s.buyerMemberId, sellerId: s.sellerId, action: "buyer_address.create", targetType: "BuyerAddress", targetId: r.address.id });
    return { ok: true as const, value: r.address };
  });
}

const EDITABLE = ["recipientName", "phone", "zipCode", "address1", "address2", "memo", "label", "isDefault"];

// 수정: 보낸 항목만 바꾼다(바꿀 항목이 하나도 없으면 400). isDefault: true면 기본 배송지로 정한다. 기본 배송지에 false를 보내면 거부한다(기본은 항상 1개).
export async function updateAddress(db: PrismaClient, s: AddressScope, id: string, raw: unknown): Promise<AddressResult<AddressView>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "invalid_shipping_address" };
  const body = raw as Record<string, unknown>;
  if (!EDITABLE.some((k) => k in body)) return { ok: false, reason: "invalid_shipping_address" };
  if (body.isDefault !== undefined && typeof body.isDefault !== "boolean") return { ok: false, reason: "invalid_shipping_address" };
  return db.$transaction(async (tx) => {
    await lockBuyerAddresses(tx, s);
    const cur = await tx.buyerAddress.findFirst({ where: { id, sellerId: s.sellerId, buyerMemberId: s.buyerMemberId } });
    if (!cur) return { ok: false as const, reason: "address_not_found" as const };
    if (cur.isDefault && body.isDefault === false) return { ok: false as const, reason: "default_address_required" as const };
    const pick = (k: keyof Fields) => (k in body ? body[k] : cur[k]);
    const f = parseFields({
      recipientName: pick("recipientName"),
      phone: pick("phone"),
      zipCode: pick("zipCode"),
      address1: pick("address1"),
      address2: pick("address2"),
      memo: pick("memo"),
      label: pick("label"),
    });
    if (typeof f === "string") return { ok: false as const, reason: f };
    const dup = await tx.buyerAddress.findFirst({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId, id: { not: id }, ...sameAddress(f) }, select: { id: true } });
    if (dup) return { ok: false as const, reason: "duplicate_address" as const };
    const now = await dbNow(tx);
    await tx.buyerAddress.update({ where: { id }, data: { ...f, updatedAt: now } });
    if (body.isDefault === true && !cur.isDefault) await makeDefault(tx, s, id, now);
    await writeAudit(tx, { actorType: "BUYER", actorId: s.buyerMemberId, sellerId: s.sellerId, action: "buyer_address.update", targetType: "BuyerAddress", targetId: id });
    return { ok: true as const, value: await tx.buyerAddress.findUniqueOrThrow({ where: { id }, select: VIEW }) };
  });
}

export async function deleteAddress(db: PrismaClient, s: AddressScope, id: string): Promise<AddressResult<null>> {
  return db.$transaction(async (tx) => {
    await lockBuyerAddresses(tx, s);
    const cur = await tx.buyerAddress.findFirst({ where: { id, sellerId: s.sellerId, buyerMemberId: s.buyerMemberId }, select: { isDefault: true } });
    if (!cur) return { ok: false as const, reason: "address_not_found" as const };
    await tx.buyerAddress.delete({ where: { id } });
    if (cur.isDefault) {
      const next = await tx.buyerAddress.findFirst({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId }, orderBy: RECENT, select: { id: true } });
      if (next) await makeDefault(tx, s, next.id, await dbNow(tx));
    }
    await writeAudit(tx, { actorType: "BUYER", actorId: s.buyerMemberId, sellerId: s.sellerId, action: "buyer_address.delete", targetType: "BuyerAddress", targetId: id });
    return { ok: true as const, value: null };
  });
}

// 주문에 쓴 배송지 기록(주문 트랜잭션 안). 같은 배송지가 이미 있으면 사용 시각만 바꾼다(저장을 꺼도 바꿈).
// 없으면 save일 때만 새로 저장하고, 20개가 차 있으면 저장하지 않는다. 어느 경우든 주문은 그대로 진행한다.
export async function recordOrderAddress(tx: Tx, s: AddressScope, address: ShippingAddressInput, save: boolean, now: Date): Promise<void> {
  await lockBuyerAddresses(tx, s);
  const used = await tx.buyerAddress.updateMany({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId, ...sameAddress(address) }, data: { lastUsedAt: now } });
  if (used.count > 0 || !save) return;
  const r = await insert(tx, s, { ...address, label: null }, false, now, now);
  if (r !== "too_many_addresses" && r.created) {
    await writeAudit(tx, { actorType: "BUYER", actorId: s.buyerMemberId, sellerId: s.sellerId, action: "buyer_address.create", targetType: "BuyerAddress", targetId: r.address.id, after: { source: "order" } });
  }
}
