import { describe, expect, it } from "vitest";
import { DEFAULT_COST_LIMIT_WON, DEFAULT_PLANNER_MODEL, plannerConfig } from "../../lib/server/automation/config";
import { FakeBrowserExecutor, FakePlanner } from "../../lib/server/automation/fakes";
import { publicError } from "../../lib/server/automation/jobs";
import { sanitizeObservation, validateDecision, type AutomationAction } from "../../lib/server/automation/ports";
import { backoffMs } from "../../lib/server/automation/queue";
import { TERMINAL, TRANSITIONS, canTransition, sourcesOf } from "../../lib/server/automation/states";
import { STEPS, VERIFY_STEP_INDEX } from "../../lib/server/automation/steps";

const secrets = { webhook_url: "https://hooks.test/abc/0123456789", webhook_secret: "s3cr3t-value-0123456789" };
const step = (kind: "browser" | "obs" | "verify") => STEPS.find((s) => s.kind === kind)!;
const d = (action: AutomationAction, costWon = 1) => ({ action, costWon });

describe("자동 연결 상태기계", () => {
  it("결제 대기에서는 결제 확인(QUEUED)·실패·취소로만 간다. 실행은 대기열을 거쳐야 한다", () => {
    expect(TRANSITIONS.AWAITING_PAYMENT).toEqual(["QUEUED", "FAILED", "CANCELED"]);
    expect(canTransition("AWAITING_PAYMENT", "RUNNING")).toBe(false);
    expect(sourcesOf("RUNNING")).toEqual(["QUEUED"]);
  });

  it("끝난 상태에서는 어디로도 가지 않는다", () => {
    for (const t of TERMINAL) expect(TRANSITIONS[t]).toEqual([]);
  });

  it("완료는 검증 단계에서만, 고객 대기에서 실행으로 바로 가지 않는다", () => {
    expect(sourcesOf("SUCCEEDED")).toEqual(["VERIFYING"]);
    expect(canTransition("NEEDS_CUSTOMER", "RUNNING")).toBe(false);
    expect(sourcesOf("CANCELED")).toEqual(["AWAITING_PAYMENT", "QUEUED", "RUNNING", "NEEDS_CUSTOMER", "VERIFYING"]);
    expect(VERIFY_STEP_INDEX).toBe(STEPS.length - 1);
  });
});

describe("다시 시도 간격", () => {
  it("지수로 늘고 상한 10분, 지터는 50~100%", () => {
    expect(backoffMs(1, () => 1)).toBe(5_000);
    expect(backoffMs(2, () => 1)).toBe(10_000);
    expect(backoffMs(3, () => 0)).toBe(10_000);
    expect(backoffMs(30, () => 1)).toBe(600_000);
  });
});

describe("모델 입력 정리와 행동 검사", () => {
  it("관찰에서 비밀값을 지우고 길이를 자른다", () => {
    const o = sanitizeObservation({ url: `https://admin.cafe24.com/?k=${secrets.webhook_secret}`, text: `값 ${secrets.webhook_url} ${"가".repeat(9000)}` }, secrets);
    expect(JSON.stringify(o)).not.toContain(secrets.webhook_secret);
    expect(JSON.stringify(o)).not.toContain(secrets.webhook_url);
    expect(o.untrustedPageText.length).toBe(8000);
  });

  it("허용 호스트(https, 하위 도메인 포함)만 이동, 비슷한 가짜 도메인·http·계정 포함 주소는 거부", () => {
    const b = step("browser");
    expect(validateDecision(b, d({ type: "navigate", url: "https://shop1.cafe24.com/admin" }), secrets)).toEqual({ ok: true });
    for (const url of ["https://cafe24.com.evil.test/", "https://evilcafe24.com/", "http://admin.cafe24.com/", "https://u:p@admin.cafe24.com/", "javascript:alert(1)"]) {
      expect(validateDecision(b, d({ type: "navigate", url }), secrets)).toEqual({ ok: false, reason: "host_not_allowed" });
    }
  });

  it("단계에 없는 행동, 비밀값을 글자로 적기, 모르는 비밀 참조·고객 행동, 음수 비용은 거부", () => {
    expect(validateDecision(step("obs"), d({ type: "navigate", url: "https://admin.cafe24.com/" }), secrets)).toEqual({ ok: false, reason: "action_not_allowed" });
    expect(validateDecision(step("browser"), d({ type: "send_test_event" }), secrets)).toEqual({ ok: false, reason: "action_not_allowed" });
    expect(validateDecision(step("browser"), d({ type: "fill", target: "메모", value: { text: `x ${secrets.webhook_secret}` } }), secrets)).toEqual({ ok: false, reason: "secret_in_text" });
    expect(validateDecision(step("browser"), d({ type: "fill", target: "웹훅", value: { secretRef: "admin_password" as never } }), secrets)).toEqual({ ok: false, reason: "bad_secret_ref" });
    // 비밀값은 정해 둔 칸에만(작업서가 단계마다 정함). 목록이 없거나 다른 칸·다른 비밀이면 거부
    const allowed = { webhook_url: ["주문 알림 주소"] } as const;
    expect(validateDecision(step("browser"), d({ type: "fill", target: "주문 알림 주소", value: { secretRef: "webhook_url" } }), secrets, allowed)).toEqual({ ok: true });
    expect(validateDecision(step("browser"), d({ type: "fill", target: "주문 알림 주소", value: { secretRef: "webhook_url" } }), secrets)).toEqual({ ok: false, reason: "secret_target_not_allowed" });
    expect(validateDecision(step("browser"), d({ type: "fill", target: "메모", value: { secretRef: "webhook_url" } }), secrets, allowed)).toEqual({ ok: false, reason: "secret_target_not_allowed" });
    expect(validateDecision(step("browser"), d({ type: "fill", target: "주문 알림 주소", value: { secretRef: "webhook_secret" } }), secrets, allowed)).toEqual({ ok: false, reason: "secret_target_not_allowed" });
    expect(validateDecision(step("verify"), d({ type: "request_customer", action: "PAY" as never }), secrets)).toEqual({ ok: false, reason: "bad_customer_action" });
    expect(validateDecision(step("verify"), d({ type: "send_test_event" }, -1), secrets)).toEqual({ ok: false, reason: "bad_cost" });
  });
});

describe("가짜 구현", () => {
  it("운영 환경에서는 만들 수 없다", () => {
    expect(() => new FakePlanner(10, "production")).toThrow();
    expect(() => new FakeBrowserExecutor(0, "production")).toThrow();
  });
});

describe("화면용 실패 사유", () => {
  it("정해 둔 코드만 내보내고 원문은 step_failed로 바꾼다", () => {
    expect(publicError(null)).toBeNull();
    expect(publicError("cost_limit")).toBe("cost_limit");
    expect(publicError("unsafe_action:host_not_allowed")).toBe("unsafe_action");
    expect(publicError("step_action_limit:test_event_verify")).toBe("step_action_limit:test_event_verify");
    expect(publicError("step_action_limit:Cafe24")).toBe("step_failed");
    expect(publicError("Cafe24 관리자 오류")).toBe("step_failed");
  });
});

describe("판단 모델 설정(확정 ⑦)", () => {
  it("모델 이름·작업당 비용 상한을 환경변수로 바꾸고, 잘못된 상한(0·음수·소수·과대)은 기본값", () => {
    expect(plannerConfig({})).toEqual({ model: DEFAULT_PLANNER_MODEL, costLimitWon: DEFAULT_COST_LIMIT_WON });
    expect(plannerConfig({ AUTOMATION_PLANNER_MODEL: "pro-next", AUTOMATION_COST_LIMIT_WON: "2000" })).toEqual({ model: "pro-next", costLimitWon: 2000 });
    for (const v of ["0", "-1", "1.5", "abc", "1000000"]) expect(plannerConfig({ AUTOMATION_COST_LIMIT_WON: v }).costLimitWon).toBe(DEFAULT_COST_LIMIT_WON);
  });
});
