import { defineConfig } from "@playwright/test";

// 판매자 화면 e2e. 폐기용 DB(이름이 _test로 끝남)에 migrate deploy → node scripts/dev-seed.mjs로 데모 데이터를 넣고,
// npm run build && npx next start -p 3100으로 앱을 띄운 뒤 npm run test:e2e로 실행한다.
// E2E_BASE_URL(기본 http://localhost:3100), E2E_PASSWORD(데모 계정 비밀번호)가 필요하다.
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
});
