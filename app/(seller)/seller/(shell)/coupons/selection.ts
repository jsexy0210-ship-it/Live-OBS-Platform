const PREFIX = "streamshop:coupon-stop:";
type Stored = { scope: "coupon-stop"; sellerId: string; ids: string[] };
export function storeCouponSelection(sellerId: string, ids: string[], storage?: Pick<Storage, "setItem">): string | null {
  if (!sellerId || !ids.length || new Set(ids).size !== ids.length) return null;
  const key = PREFIX + crypto.randomUUID();
  try { (storage ?? sessionStorage).setItem(key, JSON.stringify({ scope: "coupon-stop", sellerId, ids } satisfies Stored)); return key; } catch { return null; }
}
export function readCouponSelection(key: string, sellerId: string, storage?: Pick<Storage, "getItem">): string[] | null {
  if (!key.startsWith(PREFIX) || !sellerId) return null;
  try {
    const data: unknown = JSON.parse((storage ?? sessionStorage).getItem(key) ?? "null");
    if (!data || typeof data !== "object") return null;
    const value = data as Partial<Stored>;
    return value.scope === "coupon-stop" && value.sellerId === sellerId && Array.isArray(value.ids) && value.ids.length > 0 && value.ids.every((id) => typeof id === "string" && id.length > 0) && new Set(value.ids).size === value.ids.length ? [...value.ids] : null;
  } catch { return null; }
}
