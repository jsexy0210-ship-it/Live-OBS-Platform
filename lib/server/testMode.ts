// 테스트 서버 전용 모드(대표님 지시 2026-10-03, PRODUCT_SCOPE 「테스트 환경 본인확인·결제 우회」).
// 서버 환경변수 OBS_TEST_MODE=1일 때만 켜진다. 켜지면 운영 빌드(NODE_ENV=production)에서도
// - 휴대폰 본인확인은 가짜 공급자(인증번호 FAKE_IDENTITY_OTP 000000, 문자·과금 없음, identity/registry.ts)
// - 구독 결제는 가짜 결제 공급자(실제 돈 이동 없음, 결제 기록의 공급자 이름 fake, billing/registry.ts)
// - 시험 데이터 명령(scripts/seed-obs-test.mjs)을 쓸 수 있다.
// 운영 서버에는 넣지 않는다. 값이 정확히 "1"이 아니면 꺼진 것으로 본다.
export function isTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OBS_TEST_MODE === "1";
}

const warned = globalThis as unknown as { obsTestModeWarned?: boolean };

// 테스트 모드로 가짜 공급자를 처음 만들 때 서버 로그에 한 번 경고를 남긴다.
export function warnTestModeOnce() {
  if (warned.obsTestModeWarned) return;
  warned.obsTestModeWarned = true;
  console.warn("[test-mode] OBS_TEST_MODE=1: 휴대폰 본인확인·구독 결제를 가짜 공급자로 처리해요. 테스트 서버에서만 켜 주세요.");
}
