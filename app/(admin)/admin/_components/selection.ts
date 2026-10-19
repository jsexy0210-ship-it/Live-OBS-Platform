// Bulk detail URLs contain the exact bounded selection, independent of collection pagination.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function selectedIds(value: string | null): string[] | null {
  const ids = value?.split(",").map(id => id.toLowerCase()) ?? [];
  return ids.length > 0 && ids.length <= 50 && ids.every(id => UUID.test(id)) && new Set(ids).size === ids.length ? ids : null;
}
export function listReturnTo(value: string | null, fallback: string): string {
  if (!value) return fallback;
  try { const url = new URL(value, "https://admin.invalid"); return url.origin === "https://admin.invalid" && url.pathname === fallback ? `${url.pathname}${url.search}` : fallback; } catch { return fallback; }
}
export function selectionHref(path: string, ids: string[], returnTo: string): string {
  return `${path}?${new URLSearchParams({ ids: ids.join(","), returnTo })}`;
}
