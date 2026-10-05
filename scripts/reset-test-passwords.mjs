// 테스트 서버(obs-test) 전용: 판매자 계정(SellerUser)·구매자 회원(BuyerMember) 전원의 비밀번호를 「1234」로 맞춘다
// (2026-10-05 대표님 지시 「테스트계정 싹다 비밀번호 1234로 통일」, 마스터 관리자(PlatformAdmin)는 제외).
// - OBS_TEST_MODE=1일 때만 실행한다(seed-obs-test.mjs와 같은 플래그). 운영 서버에는 이 값을 넣지 않는다.
// - 비밀번호 길이 규칙은 이 시험 명령에서만 건너뛴다(서비스의 가입·변경 규칙은 그대로).
// - 탈퇴(deletedAt)한 구매자는 건드리지 않는다. 판매자 계정은 credentialVersion을 올려 기존 로그인을 끊는다.
// - 로그에는 바꾼 계정 수만 남긴다(아이디·이메일은 출력하지 않음).
import { hash } from "@node-rs/argon2";
import { PrismaClient } from "@prisma/client";

if (process.env.OBS_TEST_MODE !== "1") {
  console.error("테스트 서버 모드(OBS_TEST_MODE=1)가 아니에요. 테스트 서버에서만 실행해요.");
  process.exit(1);
}

const TEST_PASSWORD = "1234";
const db = new PrismaClient();

async function main() {
  const passwordHash = await hash(TEST_PASSWORD);
  const sellers = await db.sellerUser.updateMany({ data: { passwordHash, credentialVersion: { increment: 1 } } });
  const buyers = await db.buyerMember.updateMany({ where: { deletedAt: null }, data: { passwordHash } });
  console.log(`비밀번호를 바꿨어요: 판매자 계정 ${sellers.count}개, 구매자 회원 ${buyers.count}명 (마스터 관리자는 그대로)`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
