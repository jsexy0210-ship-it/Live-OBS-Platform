// 자동 연결 단계. 순서대로 실행하고 stepIndex에 진행 위치를 남긴다(중단 후 이어 하기).
// kind: browser = 서버 브라우저 실행기(공식 API·OAuth로 안 되는 관리 화면만), obs = 고객 PC 로컬 연결 도구(OBS WebSocket),
// verify = 테스트 이벤트를 보내 실제 표시를 확인. 검증 단계에서 작업 상태는 VERIFYING이다.
export type StepKind = "browser" | "obs" | "verify";
export type Step = { key: string; kind: StepKind };

export const STEPS: readonly Step[] = [
  { key: "shop_connect", kind: "browser" },
  { key: "webhook_setup", kind: "browser" },
  { key: "obs_overlay_install", kind: "obs" },
  { key: "display_settings", kind: "obs" },
  { key: "test_event_verify", kind: "verify" },
];

export const VERIFY_STEP_INDEX = STEPS.findIndex((s) => s.kind === "verify");
