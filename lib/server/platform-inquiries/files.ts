// 문의 첨부 파일(사진 외): .txt·.log·.zip만. 사진(.png·.jpg)은 기존 사진 올리기를 쓴다.
// - 파일당 5MB, 글당 5개(사진과 합쳐), 합계 20MB(사진과 합쳐). 올릴 때 확장자·내용을 검사하고 DB에 둔다(무료 저장).
// - 실행 형식·그 밖의 확장자는 거부한다. zip은 열어 보지 않는다(시그니처만 확인). 텍스트는 NUL 바이트가 있으면 거부한다.
// - 내려받기는 항상 attachment + nosniff + 고정 content-type(확장자로 정함, 올린 사람이 정하지 못함).
export const FILE_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENTS_PER_MESSAGE = 5;
export const ATTACHMENTS_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
export const FILE_NAME_MAX = 100;

const TYPES: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".zip": "application/zip",
};

export type InquiryFileCheck = { ok: true; name: string; contentType: string } | { ok: false; reason: "unsupported_file" };

// 파일 이름: 경로·제어 문자·따옴표 등을 지우고 100자 안으로(확장자는 남김). 허용 확장자(소문자, 점 포함)가 아니면 null. 공지 첨부도 이 함수를 쓴다.
export function cleanFileNameWith(raw: unknown, allowed: readonly string[]): { name: string; ext: string } | null {
  if (typeof raw !== "string") return null;
  const base = raw.normalize("NFKC").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, "").trim().replace(/^\.+/, "");
  const dot = cleaned.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = cleaned.slice(dot).toLowerCase();
  if (!allowed.includes(ext)) return null;
  const stem = cleaned.slice(0, dot).trim();
  if (!stem) return null;
  return { name: stem.slice(0, FILE_NAME_MAX - ext.length) + ext, ext };
}
export const cleanFileName = (raw: unknown) => cleanFileNameWith(raw, Object.keys(TYPES));

export function checkInquiryFile(rawName: unknown, bytes: Buffer): InquiryFileCheck {
  const n = cleanFileName(rawName);
  if (!n || bytes.length === 0) return { ok: false, reason: "unsupported_file" };
  if (n.ext === ".zip") {
    const sig = bytes.subarray(0, 4);
    const ok = sig.length === 4 && sig[0] === 0x50 && sig[1] === 0x4b && ((sig[2] === 3 && sig[3] === 4) || (sig[2] === 5 && sig[3] === 6));
    if (!ok) return { ok: false, reason: "unsupported_file" };
  } else if (bytes.includes(0)) {
    return { ok: false, reason: "unsupported_file" };
  }
  return { ok: true, name: n.name, contentType: TYPES[n.ext] };
}

// Content-Disposition 파일 이름: ASCII 대체 이름 + UTF-8 이름
const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, "_").replace(/[";\\]/g, "_");
export function inquiryFileResponse(row: { data: Uint8Array; contentType: string; name: string } | null): Response {
  const base = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
  if (!row) return new Response("not found", { status: 404, headers: base });
  return new Response(new Uint8Array(row.data), {
    headers: {
      ...base,
      "content-type": row.contentType,
      "content-disposition": `attachment; filename="${asciiName(row.name)}"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "cache-control": "private, max-age=60",
    },
  });
}
