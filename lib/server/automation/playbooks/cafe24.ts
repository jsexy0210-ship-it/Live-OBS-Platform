import type { Playbook } from "../playbook";

// 초안(draft). 시험용 쇼핑몰 연습 전이라 화면 단서·기준 이미지·성공 사례가 비어 있거나 가정값이다.
// 연습(practice.ts)으로 연속 성공 기준을 넘기기 전에는 지원 목록에 오르지 않는다. 공식 OAuth·앱 설치 경로를 먼저 쓴다(docs/AUTOMATION.md 4절).
export const cafe24Playbook: Playbook = {
  id: "cafe24",
  version: 1,
  platform: "Cafe24",
  hostSuffixes: ["cafe24.com"],
  status: "draft",
  steps: {
    shop_connect: {
      guide: "앱 설치 화면에서 우리 앱 설치를 누르고, 권한 승인은 고객이 직접 한다. 설치 완료 표시가 보이면 단계 끝.",
      referenceImages: [],
      actions: [
        { action: { type: "navigate", url: "https://admin.cafe24.com/apps" } },
        { action: { type: "click", target: "앱 설치" }, expect: { textIncludes: ["앱 설치"] } },
        { action: { type: "step_done" }, expect: { textIncludes: ["설치 완료"] } },
      ],
      exceptions: [
        { when: { textIncludes: ["로그인"] }, then: { customerAction: "LOGIN" } },
        { when: { textIncludes: ["2단계 인증"] }, then: { customerAction: "TWO_FACTOR" } },
        { when: { textIncludes: ["자동입력 방지"] }, then: { customerAction: "CAPTCHA" } },
        { when: { textIncludes: ["권한 승인"] }, then: { customerAction: "PERMISSION_GRANT" } },
        { when: { textIncludes: ["일시적인 오류"] }, then: { retry: "admin_temporary_error" } },
      ],
      examples: [],
      secretTargets: {},
    },
    webhook_setup: {
      guide: "주문 알림 주소 칸에 webhook_url 비밀 참조를 넣고 저장한다. 저장 완료 표시가 보이면 단계 끝.",
      referenceImages: [],
      actions: [
        { action: { type: "fill", target: "주문 알림 주소", value: { secretRef: "webhook_url" } }, expect: { textIncludes: ["주문 알림"] } },
        { action: { type: "click", target: "저장" } },
        { action: { type: "step_done" }, expect: { textIncludes: ["저장"] } },
      ],
      exceptions: [{ when: { textIncludes: ["로그인"] }, then: { customerAction: "LOGIN" } }],
      examples: [],
      secretTargets: { webhook_url: ["주문 알림 주소"] },
    },
    obs_overlay_install: {
      guide: "로컬 연결 도구로 OBS에 주문 오버레이 브라우저 소스를 추가한다.",
      referenceImages: [],
      actions: [{ action: { type: "obs_add_overlay_source" }, expect: { textIncludes: ["OBS 연결됨"] } }, { action: { type: "step_done" } }],
      exceptions: [{ when: { textIncludes: ["OBS 연결 안 됨"] }, then: { customerAction: "LOCAL_TOOL" } }],
      examples: [],
      secretTargets: {},
    },
    display_settings: {
      guide: "오버레이 표시 설정(위치·크기)을 기본값으로 맞춘다.",
      referenceImages: [],
      actions: [{ action: { type: "obs_apply_display_settings" }, expect: { textIncludes: ["OBS 연결됨"] } }, { action: { type: "step_done" } }],
      exceptions: [{ when: { textIncludes: ["OBS 연결 안 됨"] }, then: { customerAction: "LOCAL_TOOL" } }],
      examples: [],
      secretTargets: {},
    },
    test_event_verify: {
      guide: "테스트 주문을 보내고 OBS 오버레이에 실제로 보이는지 확인한다. 보이지 않으면 끝내지 않는다.",
      referenceImages: [],
      actions: [{ action: { type: "send_test_event" } }, { action: { type: "check_overlay_shows_test_event" } }, { action: { type: "step_done" } }],
      exceptions: [{ when: { textIncludes: ["OBS 연결 안 됨"] }, then: { customerAction: "LOCAL_TOOL" } }],
      examples: [],
      secretTargets: {},
    },
  },
};
