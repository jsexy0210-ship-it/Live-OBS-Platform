import { NextResponse } from "next/server";
import { AuthError } from "../authz/errors";
import { ObsPairingError } from "./errors";
import { assertSameOrigin, noStore } from "../http/route";

// 다른 오류의 Prisma 입력/비밀값을 공용 errorResponse 로그로 넘기지 않는다.
export function pairingRoute<A extends unknown[]>(cookieAuth: boolean, handler: (req: Request, ...args: A) => Promise<Response>) {
  return async (req: Request, ...args: A) => {
    try {
      if (cookieAuth || req.headers.has("origin")) assertSameOrigin(req);
      if (!cookieAuth && req.headers.has("cookie")) throw new AuthError(403, "obs_bootstrap_cookie_denied");
      return noStore(await handler(req, ...args));
    } catch (e) {
      const known = e instanceof AuthError || e instanceof ObsPairingError;
      return noStore(NextResponse.json({ error: known ? e.code : "obs_pairing_unavailable" }, { status: known ? e.status : 503 }));
    }
  };
}

export async function pairingJson(req: Request, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { void reader.cancel(); reject(new ObsPairingError(408, "obs_request_timeout")); }, 5_000);
    });
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 2048) { await reader.cancel(); throw new ObsPairingError(413, "obs_request_too_large"); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let data: unknown;
    try { data = size ? JSON.parse(new TextDecoder().decode(bytes)) : {}; } catch { throw new ObsPairingError(400, "obs_invalid_request"); }
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(k => !fields.includes(k))) throw new ObsPairingError(400, "obs_invalid_request");
    return data as Record<string, unknown>;
  } finally { if (timer) clearTimeout(timer); reader.releaseLock(); }
}

export function pairingProof(req: Request): string | undefined {
  return req.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
}
