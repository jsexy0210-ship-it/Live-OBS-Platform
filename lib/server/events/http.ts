import { EventError } from "./errors";

// Content-Length에만 의존하지 않는다. chunked 요청도 같은 한도로 막는다.
export async function readEventJson(req: Request): Promise<Record<string, unknown>> {
  const limit = 8_192;
  if (Number(req.headers.get("content-length")) > limit) throw new EventError(413, "request_too_large");
  const reader = req.body?.getReader();
  if (!reader) throw new EventError(400, "invalid_request");
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > limit) { await reader.cancel(); throw new EventError(413, "request_too_large"); }
    chunks.push(next.value);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object_required");
    return value as Record<string, unknown>;
  } catch { throw new EventError(400, "invalid_request"); }
}
