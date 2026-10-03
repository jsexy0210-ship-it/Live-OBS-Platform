// 판매자 화면에서 쓰는 API 호출. 같은 출처 요청이라 쿠키·Origin은 브라우저가 붙인다.
// 실패 응답의 본문 전체는 body에 둔다(error·message 밖의 값, 예: 재가입 제한의 rejoinAvailableAt).
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; message?: string; body?: Record<string, unknown> };

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, status: res.status, data: data as T };
  // 로그인이 풀렸으면(만료·로그아웃·비밀번호 변경) 어느 화면에서든 로그인으로 보낸다. 로그인·로그아웃 요청 자체의 401은 화면이 처리한다.
  if (res.status === 401 && path.startsWith("/api/seller/") && !path.startsWith("/api/seller/auth/")) {
    window.location.assign(`/seller/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  const body = data as { error?: string; message?: string } & Record<string, unknown>;
  return { ok: false, status: res.status, error: body.error ?? "unknown", message: body.message, body };
}

// 서버가 준 안내 문구가 있으면 그대로, 없으면 상태별 기본 문구
export function failMessage(r: { status: number; message?: string }, fallback = "잠시 뒤 다시 시도해 주세요"): string {
  if (r.message) return r.message;
  if (r.status === 0) return "연결이 끊겼어요. 인터넷 연결을 확인해 주세요";
  if (r.status === 402) return "이용 기간이 끝나서 지금은 할 수 없어요. 구독하면 바로 다시 쓸 수 있어요";
  if (r.status === 403) return "이 기능은 권한이 필요해요. 대표자에게 요청해 주세요";
  if (r.status === 404) return "찾을 수 없어요. 이미 지워졌을 수 있어요";
  return fallback;
}

export type SellerAccess = "trial" | "paid" | "charging" | "grace" | "expired";
export type Me = { sellerId: string; userId: string; isOwner: boolean; permissions: string[]; access: SellerAccess;
  shop: { name: string; slug: string };
  user: { name: string; email: string };
  trialEndsAt: string | null;
};

// 재고 차감 시점: ORDER=주문하면 바로, PAYMENT=결제하면(기본)
export type StockDeductMode = "ORDER" | "PAYMENT";
export type ProductStatus = "DRAFT" | "ON_SALE" | "SOLD_OUT" | "HIDDEN";
export type ProductOption = { id: string; name: string; priceDelta: number; stock: number; sku: string | null; sortOrder: number };
export type Product = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  status: ProductStatus;
  stockDeductMode: StockDeductMode;
  sortOrder: number;
  createdAt: string;
  options: ProductOption[];
};
