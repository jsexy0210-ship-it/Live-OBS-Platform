import type { Playbook } from "../playbook";

// 초안(draft). 시험용 쇼핑몰 연습 전이라 화면 단서·기준 이미지·성공 사례가 비어 있거나 가정값이다.
// 연습(practice.ts)으로 연속 성공 기준을 넘기기 전에는 지원 목록에 오르지 않는다. 공식 OAuth·앱 설치 경로를 먼저 쓴다(docs/AUTOMATION.md 4절).
export const cafe24Playbook: Playbook = {
  id: "cafe24",
  version: 1,
  platform: "Cafe24",
  hostSuffixes: ["cafe24.com"],
  // 쇼핑몰 아이디(<몰>.cafe24.com의 <몰>): 영문 소문자·숫자 4~16자(공개 자료 기준 가정값, 공식 문서 직접 열람 불가 — 연습 때 확인).
  // 예약 이름: 플랫폼 중앙·서비스 호스트(관리자 중앙 admin, 로그인 센터 eclogin, 개발자센터 developers, API api, 대표 사이트 www 등).
  // 근거: 공개 자료 검색의 관리자·로그인 센터·개발자센터 주소. 목록 밖 서비스 호스트가 실습 때 확인되면 여기에 더한다.
  shopLabel: {
    pattern: /^[a-z0-9]{4,16}$/,
    reserved: ["admin", "www", "api", "eclogin", "developers", "developer", "echosting", "help", "support", "login", "mail", "store", "static", "image", "img", "cdn"],
  },
  status: "draft",
  // 관리자 화면은 쇼핑몰 자체 하위 도메인(<몰>.cafe24.com/admin, /disp/admin/…)에 있다(공개 자료 기준, 공식 문서 직접 열람 불가 — 연습 때 확인).
  // 같은 호스트에 쇼핑몰 앞 화면이 있으므로 경로 접두사와 로그인 상태 단서(로그아웃 버튼)를 함께 본다. 단서 문구는 가정값.
  secretOrigin: { pathPrefixes: ["/disp/admin/", "/admin/"], adminCue: { textIncludes: ["로그아웃"] } },
  steps: {
    shop_connect: {
      guide: "앱 설치 화면에서 우리 앱 설치를 누르고, 권한 승인은 고객이 직접 한다. 설치 완료 표시가 보이면 단계 끝.",
      referenceImages: [],
      actions: [
        { action: { type: "navigate", url: "https://{shop}/disp/admin/shop1/" } },
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
      allowedTargets: ["앱 설치"],
      // 관리자 경로만(초안 가정: 실제 앱 설치 화면 경로·쿼리는 실습 때 확인)
      allowedUrls: { pathPrefixes: ["/disp/admin/", "/admin/"], queryKeys: [] },
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
      allowedTargets: ["저장"],
      allowedUrls: { pathPrefixes: ["/disp/admin/", "/admin/"], queryKeys: [] },
    },
    obs_overlay_install: {
      guide: "로컬 연결 도구로 OBS에 주문 오버레이 브라우저 소스를 추가한다.",
      referenceImages: [],
      actions: [{ action: { type: "obs_add_overlay_source" }, expect: { textIncludes: ["OBS 연결됨"] } }, { action: { type: "step_done" } }],
      exceptions: [{ when: { textIncludes: ["OBS 연결 안 됨"] }, then: { customerAction: "LOCAL_TOOL" } }],
      examples: [],
      secretTargets: {},
      allowedTargets: [],
      allowedUrls: { pathPrefixes: [], queryKeys: [] },
    },
    display_settings: {
      guide: "오버레이 표시 설정(위치·크기)을 기본값으로 맞춘다.",
      referenceImages: [],
      actions: [{ action: { type: "obs_apply_display_settings" }, expect: { textIncludes: ["OBS 연결됨"] } }, { action: { type: "step_done" } }],
      exceptions: [{ when: { textIncludes: ["OBS 연결 안 됨"] }, then: { customerAction: "LOCAL_TOOL" } }],
      examples: [],
      secretTargets: {},
      allowedTargets: [],
      allowedUrls: { pathPrefixes: [], queryKeys: [] },
    },
    test_event_verify: {
      guide: "테스트 주문을 보내고 OBS 오버레이에 실제로 보이는지 확인한다. 보이지 않으면 끝내지 않는다.",
      referenceImages: [],
      actions: [{ action: { type: "send_test_event" } }, { action: { type: "check_overlay_shows_test_event" } }, { action: { type: "step_done" } }],
      exceptions: [{ when: { textIncludes: ["OBS 연결 안 됨"] }, then: { customerAction: "LOCAL_TOOL" } }],
      examples: [],
      secretTargets: {},
      allowedTargets: [],
      allowedUrls: { pathPrefixes: [], queryKeys: [] },
    },
  },
  // 되돌리기(초안 가정: 실제 버튼 문구·경로는 실습 때 확인). 위험 단어(삭제 등)를 쓰지 않는 문구로 적는다.
  rollback: [
    {
      forStep: "obs_overlay_install",
      kind: "obs",
      actions: [{ action: { type: "obs_remove_overlay_source" }, expect: { textIncludes: ["OBS 연결됨"] } }],
      allowedTargets: [],
      allowedUrls: { pathPrefixes: [], queryKeys: [] },
    },
    {
      forStep: "webhook_setup",
      kind: "browser",
      actions: [
        { action: { type: "navigate", url: "https://{shop}/disp/admin/shop1/" } },
        { action: { type: "click", target: "주문 알림 끄기" }, expect: { textIncludes: ["주문 알림"] } },
      ],
      allowedTargets: ["주문 알림 끄기"],
      allowedUrls: { pathPrefixes: ["/disp/admin/", "/admin/"], queryKeys: [] },
    },
    {
      forStep: "shop_connect",
      kind: "browser",
      actions: [
        { action: { type: "navigate", url: "https://{shop}/disp/admin/shop1/" } },
        { action: { type: "click", target: "앱 사용 중지" }, expect: { textIncludes: ["설치 완료"] } },
      ],
      allowedTargets: ["앱 사용 중지"],
      allowedUrls: { pathPrefixes: ["/disp/admin/", "/admin/"], queryKeys: [] },
    },
  ],
};
