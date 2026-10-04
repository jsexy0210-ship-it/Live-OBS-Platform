import type { IdentityVerification, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { hashToken } from "../auth/token";

// 본인확인 시작 재시도 키(attemptKey, 클라이언트가 만든 UUID). 응답이 끊겨 같은 키로 다시 보낸 시작 요청은
// 새 기록·새 문자·일일 횟수를 쓰지 않고 같은 기록과 같은 ownerToken을 돌려준다(구매자 가입·파트너스 가입·비밀번호 찾기 공통).

// 첫 문자를 보내는 중으로 보는 시간. 이 안에 같은 키가 다시 오면 기다리지 않고 start_in_progress로 돌려준다.
export const FIRST_SEND_WINDOW_MS = 20_000;
// 보내는 중(409 start_in_progress)일 때 화면에 보여 줄 문구
export const START_IN_PROGRESS_MESSAGE = "인증번호를 보내고 있어요. 잠시 뒤 다시 시도해 주세요";
// 파트너스 아이디·비밀번호 찾기·직원 본인확인 연결(합니다체)
export const START_IN_PROGRESS_MESSAGE_FORMAL = "인증번호를 보내고 있습니다. 잠시 뒤 다시 시도해 주십시오";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 빠지면 키 없이 시작(null), 있으면 UUID여야 한다(아니면 false = 입력 오류).
export function parseAttemptKey(raw: unknown): string | null | false {
  if (raw === undefined) return null;
  return typeof raw === "string" && UUID_RE.test(raw) ? raw.toLowerCase() : false;
}

// 키로 시작한 기록의 ownerToken은 용도·키·기록 id로 정해진다. 같은 키 재요청이 몇 번 겹쳐도 모두 같은 토큰을 받으므로
// 응답이 어떤 순서로 도착해도 브라우저 쿠키가 무효가 되지 않는다. 키를 가진 쪽만 만들 수 있고(키는 브라우저만 안다),
// DB에는 키·토큰 모두 해시만 있다.
export function keyedOwnerToken(scope: string, attemptKey: string, verificationId: string) {
  return createHash("sha256").update(`${scope}\0${attemptKey.toLowerCase()}\0${verificationId}`).digest("base64url");
}

// 키로 시작한 기록 재사용 판정. 호출한 쪽이 키별 잠금을 잡은 트랜잭션 안에서 같은 키의 기록(same)을 찾아 넘긴다.
// - 없으면 null(새로 시작).
// - 확인 전(PENDING)이고 첫 문자를 보냈으면 그 기록을 그대로 쓴다(reused).
// - 아직 보내는 중이면(FIRST_SEND_WINDOW_MS 안) start_in_progress.
// - 보내는 중으로 둔 채 그 시간이 지났으면(앞 요청이 멈춤) 공급자가 문자를 받았는지 알 수 없어 같은 요청 id로 다시 보내지 않는다.
//   그 기록을 FAILED로 버리고(키 비움) null(새 기록·새 요청 id로 처음부터, 일일 횟수에 1회 더 들어감).
// - 확인 전이 아니면(확인됨·만료·실패) 그 상태의 오류.
export async function reuseKeyedAttempt(
  tx: Prisma.TransactionClient,
  same: IdentityVerification | null,
  now: Date,
): Promise<null | { kind: "reused"; verificationId: string } | { kind: "refused"; reason: "already_verified" | "expired" | "failed" | "start_in_progress" }> {
  if (!same) return null;
  if (same.status === "PENDING" && same.expiresAt > now) {
    if (same.sendCount > 0) return { kind: "reused", verificationId: same.id };
    if (same.sendStartedAt && now.getTime() - same.sendStartedAt.getTime() < FIRST_SEND_WINDOW_MS) return { kind: "refused", reason: "start_in_progress" };
    // 앞 요청이 멈췄다. 보낸 시작 시각이 그대로일 때만 버린다(compare-and-set). 늦게 끝난 앞 요청은 실패로 돌려받는다.
    const dropped = await tx.identityVerification.updateMany({
      where: { id: same.id, status: "PENDING", sendCount: 0, sendStartedAt: same.sendStartedAt },
      data: { status: "FAILED", attemptKeyHash: null },
    });
    return dropped.count === 1 ? null : { kind: "refused", reason: "start_in_progress" };
  }
  if (same.status === "VERIFIED") return { kind: "refused", reason: "already_verified" };
  if (same.status === "FAILED") return { kind: "refused", reason: "failed" };
  return { kind: "refused", reason: "expired" };
}

// 쇼핑몰이 없는 기록(파트너스 가입) 등 (sellerId, attemptKeyHash) 유니크가 듣지 않는 용도의 키 해시.
// 용도와 범위(같은 쇼핑몰·같은 아이디 등)를 키에 섞어, 다른 요청에 같은 키를 써도 다른 기록이 된다.
export function scopedAttemptKeyHash(purpose: string, scope: string, attemptKey: string) {
  return hashToken(`${purpose}\0${scope}\0${attemptKey}`);
}
