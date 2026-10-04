// 판매자 화면에서 쓰는 API 호출. 같은 출처 요청이라 쿠키·Origin은 브라우저가 붙인다.
// 실패 응답의 본문 전체는 body에 둔다(error·message 밖의 값, 예: 재가입 제한의 rejoinAvailableAt).
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; message?: string; body?: Record<string, unknown> };

// authRedirect: false면 401이어도 로그인으로 보내지 않는다(화면이 직접 로그인 주소를 만들 때)
export async function api<T>(path: string, init: { method?: string; body?: unknown; authRedirect?: boolean } = {}): Promise<ApiResult<T>> {
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
  if (res.status === 401 && init.authRedirect !== false && path.startsWith("/api/seller/") && !path.startsWith("/api/seller/auth/")) {
    window.location.assign(`/seller/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  const body = data as { error?: string; message?: string } & Record<string, unknown>;
  notifyPlanFeature(path, res.status, body.error);
  return { ok: false, status: res.status, error: body.error ?? "unknown", message: body.message, body };
}

// 파일 바이트를 본문 그대로 올리는 요청(이미지 업로드 등). 응답 처리와 401 로그인 이동은 api()와 같다.
export async function apiUpload<T>(path: string, file: Blob, init: { method?: "POST" | "PUT" } = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, { method: init.method ?? "POST", body: file, cache: "no-store" });
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, status: res.status, data: data as T };
  if (res.status === 401 && path.startsWith("/api/seller/")) {
    window.location.assign(`/seller/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  const body = data as { error?: string; message?: string } & Record<string, unknown>;
  notifyPlanFeature(path, res.status, body.error);
  return { ok: false, status: res.status, error: body.error ?? "unknown", message: body.message, body };
}

// 지금 요금제에 없는 기능이라 서버가 막으면(403 plan_feature_required) 파트너스 틀(SellerShell)이 안내 화면으로 바꾸도록 알린다
export const PLAN_FEATURE_EVENT = "seller:plan-feature-required";
function notifyPlanFeature(path: string, status: number, error: string | undefined) {
  if (status === 403 && error === "plan_feature_required" && path.startsWith("/api/seller/")) window.dispatchEvent(new Event(PLAN_FEATURE_EVENT));
}

// 화면 말투: admin=파트너스 관리자·관리자 인증 화면(합니다체), public=공개 화면(가입 신청 등, 해요체)
export type Tone = "admin" | "public";

const FAIL_TEXT: Record<Tone, { network: string; expired: string; forbidden: string; notFound: string; retry: string }> = {
  admin: {
    network: "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오",
    expired: "이용 기간이 끝나 지금은 할 수 없습니다. 구독하면 바로 다시 사용할 수 있습니다",
    forbidden: "이 기능은 권한이 필요합니다. 대표자에게 요청해 주십시오",
    notFound: "찾을 수 없습니다. 이미 삭제되었을 수 있습니다",
    retry: "잠시 후 다시 시도해 주십시오",
  },
  public: {
    network: "연결이 끊겼어요. 인터넷 연결을 확인해 주세요",
    expired: "이용 기간이 끝나서 지금은 할 수 없어요. 구독하면 바로 다시 쓸 수 있어요",
    forbidden: "이 기능은 권한이 필요해요. 대표자에게 요청해 주세요",
    notFound: "찾을 수 없어요. 이미 지워졌을 수 있어요",
    retry: "잠시 뒤 다시 시도해 주세요",
  },
};

// 서버가 준 안내 문구가 있으면 그대로, 없으면 상태별 기본 문구
// tone은 필수: 화면마다 관리자(admin, 합니다체)·공개(public, 해요체) 말투를 직접 고른다(빠진 곳은 타입 검사가 잡는다)
export function failMessage(r: { status: number; message?: string }, tone: Tone, fallback?: string): string {
  if (r.message) return r.message;
  const t = FAIL_TEXT[tone];
  if (r.status === 0) return t.network;
  if (r.status === 402) return t.expired;
  if (r.status === 403) return t.forbidden;
  if (r.status === 404) return t.notFound;
  return fallback ?? t.retry;
}

export type SellerAccess = "trial" | "paid" | "charging" | "grace" | "expired";
// 요금제가 주는 기능 권한(lib/server/billing/features.ts). 화면은 메뉴를 고르는 데만 쓰고, 막는 것은 서버가 한다
export type PlanFeature = "OVERLAY" | "EXTERNAL_INTEGRATION" | "STORE_OPERATIONS";
export type Me = { sellerId: string; userId: string; isOwner: boolean; permissions: string[]; access: SellerAccess;
  features: PlanFeature[];
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
