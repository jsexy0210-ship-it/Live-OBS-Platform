// 마스터 관리자 화면의 API 호출. 같은 출처 요청이라 쿠키·Origin은 브라우저가 붙인다.
// 로그인이 풀렸으면(401) 로그인 화면으로 보낸다(로그인 요청 자체는 화면이 처리).
export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string; message?: string };

export async function adminApi<T>(path: string, init: { method?: string; json?: unknown; file?: Blob } = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers: init.json !== undefined ? { "content-type": "application/json" } : init.file ? { "content-type": init.file.type || "application/octet-stream" } : undefined,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.file,
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, status: res.status, data: data as T };
  if (res.status === 401 && !path.startsWith("/api/admin/auth/")) {
    window.location.assign(`/admin/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  const body = data as { error?: string; message?: string };
  return { ok: false, status: res.status, error: body.error ?? "unknown", message: body.message };
}

export function failMessage(r: { status: number; message?: string }, fallback = "잠시 후 다시 시도해 주십시오."): string {
  if (r.message) return r.message;
  if (r.status === 0) return "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오.";
  if (r.status === 403) return "최고관리자만 변경할 수 있습니다.";
  if (r.status === 413) return "파일이 너무 큽니다.";
  return fallback;
}

// 로그인 뒤 돌아갈 주소: 같은 사이트의 /admin 경로만(다른 사이트로 보내는 주소는 무시)
export function safeAdminNext(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/admin") && !next.startsWith("//") ? next : "/admin/settings/branding";
}

export type AdminMe = { id: string; name: string; email: string; role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY" };
