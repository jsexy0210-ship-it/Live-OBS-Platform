// 실제 route/Origin/cookie 계약 검사. service는 mock이며 실제 DB·OBS 검증이 아니다.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COOKIE_NAMES } from "../../lib/server/auth/policy";
import { AuthError } from "../../lib/server/authz/errors";
import { EventError } from "../../lib/server/events/errors";

const handlers = vi.hoisted(() => ({ read: vi.fn(), issue: vi.fn(), join: vi.fn() }));
vi.mock("../../lib/server/db", () => ({ prisma: {} }));
vi.mock("../../lib/server/events/entries", () => ({
  EVENT_GUEST_COOKIE: "lo_event_guest",
  eventParticipantApiPath: (id: string) => `/api/public/events/${id}`,
  readPublicEventParticipation: handlers.read,
  issueEventGuestSession: handlers.issue,
  joinMobileEvent: handlers.join,
}));
import { GET } from "../../app/api/public/events/[eventId]/route";
import { POST } from "../../app/api/public/events/[eventId]/[action]/route";

const eventId = randomUUID();
const url = `http://localhost:3000/api/public/events/${eventId}`;
const params = (action: string) => ({ params: Promise.resolve({ eventId, action }) });
const request = (action: string, body: unknown = {}, cookie?: string, origin: string | null = "http://localhost:3000") => new Request(`${url}/${action}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
beforeEach(() => vi.resetAllMocks());

describe("공개 이벤트 API 권한 경계", () => {
  it("조회는 공개 계약을 캐시하지 않고 서비스 오류 상태를 보존한다", async () => {
    handlers.read.mockResolvedValue({ eventId, entryOpen: true, rewardsEnabled: false });
    const response = await GET(new Request(url), { params: Promise.resolve({ eventId }) });
    expect(await response.json()).toEqual({ eventId, entryOpen: true, rewardsEnabled: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
    handlers.read.mockRejectedValue(new EventError(404, "not_found"));
    expect((await GET(new Request(url), { params: Promise.resolve({ eventId }) })).status).toBe(404);
  });

  it.each([null, "https://foreign.invalid"])("Origin %s에서는 세션 발급과 참가가 실행되지 않는다", async origin => {
    for (const action of ["guest-session", "join"]) {
      const response = await POST(request(action, {}, undefined, origin), params(action));
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(handlers.issue).not.toHaveBeenCalled();
    expect(handlers.join).not.toHaveBeenCalled();
  });

  it.each(["execute", "cancel", "reveal", "next-round", "redisplay"])("참가 API의 %s로 이벤트를 운영할 수 없다", async action => {
    expect((await POST(request(action), params(action))).status).toBe(404);
    expect(handlers.issue).not.toHaveBeenCalled();
    expect(handlers.join).not.toHaveBeenCalled();
  });

  it("게스트 토큰은 응답 JSON에서 제외하고 이벤트 한정 HttpOnly 쿠키로 전달한다", async () => {
    const token = Buffer.alloc(32, 1).toString("base64url");
    handlers.issue.mockResolvedValue({ token, expiresAt: new Date("2026-12-31T00:00:00Z") });
    const response = await POST(request("guest-session"), params("guest-session"));
    expect(await response.json()).not.toHaveProperty("token");
    expect(response.headers.get("set-cookie")).toContain(`Path=/api/public/events/${eventId}`);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
  });

  it("파트너스·마스터 쿠키를 구매자 인증으로 전달하지 않는다", async () => {
    handlers.join.mockResolvedValue({ alreadyRegistered: false });
    await POST(request("join", {}, `${COOKIE_NAMES.seller}=seller; ${COOKIE_NAMES.admin}=admin; lo_event_guest=guest`), params("join"));
    expect(handlers.join).toHaveBeenCalledWith({}, eventId, {}, { buyerToken: undefined, guestToken: "guest" });
  });

  it("구매자 인증과 서비스 권한 거절을 보존한다", async () => {
    handlers.join.mockRejectedValue(new AuthError(401, "unauthenticated"));
    const response = await POST(request("join", {}, `${COOKIE_NAMES.buyer}=buyer`), params("join"));
    expect(handlers.join).toHaveBeenCalledWith({}, eventId, {}, { buyerToken: "buyer", guestToken: undefined });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
