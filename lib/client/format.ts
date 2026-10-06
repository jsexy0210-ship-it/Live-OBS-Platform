// 화면에 보이는 일시·날짜 공용 서식(대표님 지시 2026-10-06): 모든 일시(등록·주문·결제·취소·환불·삭제·수정·처리일)는
// 연월일+시분 한 형식 「2026.10.05 22:25」(한국 시간 KST, 24시간제). 표가 좁으면 날짜/시각 두 줄로 나눠 쓴다(formatDateTimeParts).
// 날짜만 고르는 필터·생년월일은 formatDate(「2026.10.05」)를 쓴다. 화면마다 따로 서식 함수를 만들지 않는다.
// 입력은 ISO 문자열·Date·밀리초. 없거나 잘못된 값이면 fallback(기본 빈 문자열)을 돌려준다.

type Input = string | number | Date | null | undefined;

function kstParts(v: Input): { y: string; mo: string; d: string; hh: string; mm: string } | null {
  if (v === null || v === undefined || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : new Date(v).getTime();
  if (!Number.isFinite(ms)) return null;
  const k = new Date(ms + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return { y: String(k.getUTCFullYear()), mo: p(k.getUTCMonth() + 1), d: p(k.getUTCDate()), hh: p(k.getUTCHours()), mm: p(k.getUTCMinutes()) };
}

// 「2026.10.05 22:25」
export function formatDateTime(v: Input, fallback = ""): string {
  const t = kstParts(v);
  return t ? `${t.y}.${t.mo}.${t.d} ${t.hh}:${t.mm}` : fallback;
}
// 「2026.10.05」
export function formatDate(v: Input, fallback = ""): string {
  const t = kstParts(v);
  return t ? `${t.y}.${t.mo}.${t.d}` : fallback;
}
// 「22:25」
export function formatTime(v: Input, fallback = ""): string {
  const t = kstParts(v);
  return t ? `${t.hh}:${t.mm}` : fallback;
}
// 좁은 표용 두 줄: { date: "2026.10.05", time: "22:25" }
export function formatDateTimeParts(v: Input): { date: string; time: string } | null {
  const t = kstParts(v);
  return t ? { date: `${t.y}.${t.mo}.${t.d}`, time: `${t.hh}:${t.mm}` } : null;
}

// 「방금」「2분 전」「3시간 전」「2일 전」
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
