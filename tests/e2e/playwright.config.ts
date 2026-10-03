import { defineConfig } from "@playwright/test";

// 판매자 화면 e2e. 폐기용 DB(이름이 _test로 끝남)에 migrate deploy → node scripts/dev-seed.mjs로 데모 데이터를 넣고,
// npm run build && npx next start -p 3100으로 앱을 띄운 뒤 npm run test:e2e로 실행한다.
// E2E_BASE_URL(기본 http://localhost:3100), E2E_PASSWORD(데모 계정 비밀번호)가 필요하다.
// 구매자 가입 흐름(shop-signup-flow)은 가짜 본인확인 공급자(인증번호 000000)가 도는 개발 서버에서만 돌 수 있어
// 같은 폐기용 DB로 npx next dev -p 3101을 따로 띄우고 E2E_DEV_BASE_URL(기본 http://localhost:3101)로 돌린다.
//   개발 서버에는 IDENTITY_HASH_KEY(32자 이상 테스트용 임의값, 운영 값 금지)가 있어야 인증번호 확인이 500 없이 돈다.
//   파트너스 가입·비밀번호 찾기 흐름(partners-auth-flow)도 개발 서버에서 돌고, 가짜 사업자·통신판매업 조회가 있어야 바로 승인된다:
//   BUSINESS_STATUS_PROVIDER=fake MAIL_ORDER_PROVIDER=fake (운영에서는 만들 수 없는 가짜 공급자). 실행마다 가입용 본인확인 2회를 쓴다.
//   실제 흐름 테스트 2개가 실행마다 본인확인 2회를 쓴다. 같은 IP·같은 쇼핑몰 하루 10회 한도가 있어
//   같은 DB로 하루 5번 넘게 돌리면 daily_limit_exceeded로 실패한다(DB를 새로 만들면 풀린다).
// 운영 빌드(next start)는 본인확인 키가 없으면 가입을 503으로 막으므로, 그 상태 화면은 기본 서버에서 확인한다.
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    browserName: "chromium",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  },
  projects: [
    { name: "start", testIgnore: /(shop-signup-flow|partners-auth-flow|test-mode-flow)\.spec\.ts$/ },
    { name: "dev", testMatch: /(shop-signup-flow|partners-auth-flow|test-mode-flow)\.spec\.ts$/, use: { baseURL: process.env.E2E_DEV_BASE_URL ?? "http://localhost:3101" } },
  ],
});
