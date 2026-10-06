import { createHash } from "node:crypto";
import { EventError } from "./errors";

// 요청 한 번의 내부 보호 한도다. 요금제별 참가 인원/기능 제한이 아니다.
export const EVENT_ENTRY_BATCH_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (): never => { throw new EventError(400, "invalid_entry_input"); };
export type ManualEntry = { displayName?: string; buyerMemberId?: string };
export type EntryBatch = { requestKey: string; method: "DIRECT_INPUT" | "PASTE"; entries: ManualEntry[]; requestHash: string };
export function parseEntryRequestKey(input: unknown): string {
  if (typeof input !== "string" || !UUID.test(input)) return invalid();
  return input.toLowerCase();
}
export function parseEntryDisplayName(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const name = value.trim();
  if (!name || Array.from(name).length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return invalid();
  return name;
}
function batchOf(requestKey: unknown, method: EntryBatch["method"], entries: ManualEntry[]): EntryBatch {
  if (!entries.length || entries.length > EVENT_ENTRY_BATCH_LIMIT) return invalid();
  const key = parseEntryRequestKey(requestKey);
  const memberIds = entries.flatMap(entry => entry.buyerMemberId ? [entry.buyerMemberId] : []);
  if (new Set(memberIds).size !== memberIds.length) return invalid();
  return { requestKey: key, method, entries, requestHash: createHash("sha256").update(JSON.stringify({ method, entries })).digest("hex") };
}
function objectOf(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  return input as Record<string, unknown>;
}
// 직접 입력한 이름 자체는 identity가 아니다. 회원은 명시된 기존 ID, 이름만 있는 줄은 서버 발급 row ID를 사용한다.
export function parseDirectEntries(input: unknown): EntryBatch {
  const value = objectOf(input);
  if (Object.keys(value).some(key => !["requestKey", "entries"].includes(key)) || !Array.isArray(value.entries) || value.entries.length > EVENT_ENTRY_BATCH_LIMIT) return invalid();
  const entries = value.entries.map(raw => {
    const entry = objectOf(raw);
    if (Object.keys(entry).some(key => !["displayName", "buyerMemberId"].includes(key))) return invalid();
    const buyerMemberId = entry.buyerMemberId === undefined ? undefined : parseEntryRequestKey(entry.buyerMemberId);
    // 회원 ID만 지정하면 서버가 기존 회원의 방송 닉네임을 읽는다.
    const displayName = entry.displayName === undefined && buyerMemberId ? undefined : parseEntryDisplayName(entry.displayName);
    return { ...(displayName === undefined ? {} : { displayName }), ...(buyerMemberId ? { buyerMemberId } : {}) };
  });
  return batchOf(value.requestKey, "DIRECT_INPUT", entries);
}
// 공백 줄은 제외하지만 같은 표시 이름이 나온 줄은 각각 유지한다. YouTube 자동 참가와 별도 출처다.
export function parsePastedEntries(input: unknown): EntryBatch {
  const value = objectOf(input);
  if (Object.keys(value).some(key => !["requestKey", "text"].includes(key)) || typeof value.text !== "string" || value.text.length > 8_000) return invalid();
  const lines = value.text.split(/\r\n|\n|\r/).map(line => line.trim()).filter(Boolean);
  if (lines.length > EVENT_ENTRY_BATCH_LIMIT) return invalid();
  return batchOf(value.requestKey, "PASTE", lines.map(line => ({ displayName: parseEntryDisplayName(line) })));
}
