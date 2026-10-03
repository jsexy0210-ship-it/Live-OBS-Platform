import { defineConfig } from "@playwright/test";

// 판매자 화면 e2e. 폐기용 DB(이름이 _test로 끝남)에 migrate deploy → node scripts/dev-seed.mjs로 데모 데이터를 넣고,
// npm run build && npx next start -p 3100으로 앱을 띄운 뒤 npm run test:e2e로 실행한다.
// E2E_BASE_URL(기본 http://localhost:3100), E2E_PASSWORD(데모 계정 비밀번호)가 필요하다.
// 구매자 가입 흐름(shop-signup-flow)은 가짜 본인확인 공급자(인증번호 000000)가 도는 개발 서버에서만 돌 수 있어
// 같은 폐기용 DB로 npx next dev -p 3101을 따로 띄우고 E2E_DEV_BASE_URL(기본 http://localhost:3101)로 돌린다.
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
    { name: "start", testIgnore: /shop-signup-flow\.spec\.ts$/ },
    { name: "dev", testMatch: /shop-signup-flow\.spec\.ts$/, use: { baseURL: process.env.E2E_DEV_BASE_URL ?? "http://localhost:3101" } },
  ],
});
