// 테스트 서버(obs-test) 시험 데이터: 판매자(대표자) 계정 1개, 시험 쇼핑몰 1개, 상품 몇 개.
// 실행(서버, 저장소 루트): docs/DEPLOY.md 「시험 데이터 넣기」의 한 줄. 마이그레이션 이미지(obs-web-migrate) 안에서 돈다.
// - OBS_TEST_MODE=1일 때만 실행한다(테스트 서버 전용, lib/server/testMode.ts와 같은 플래그). 운영 서버에는 이 값을 넣지 않는다.
// - 로그인 아이디·비밀번호는 실행할 때 환경변수 SEED_SELLER_LOGIN·SEED_SELLER_PASSWORD로만 받고, 저장소·로그에 남기지 않는다.
//   대표님 허용(2026-10-03): 아이디 형식·비밀번호 8자 규칙은 이 시험 데이터 명령에서만 건너뛴다(서비스의 가입·변경 규칙은 그대로).
// - 판매자가 한 명이라도 있으면 아무것도 하지 않고 끝낸다(다시 실행해도 중복 없음).
// - 실제 결제·문자 발송은 없다(DB에 행만 만든다).
// - 대표자 본인확인 정보는 시험용 인물(TEST_REPRESENTATIVE)로 채운다. 테스트 서버 모드의 가짜 본인확인 공급자는
//   CI를 `fake-ci:{이름}:{생년월일7자리}`로 만들므로, 비밀번호 찾기에서 이 이름·생년월일을 넣고 인증번호 000000을 쓰면 대표자로 확인된다.
//   CI 해시는 서버와 같은 IDENTITY_HASH_KEY HMAC-SHA256(lib/server/identity/ciHash.ts)이라 그 키가 있어야 한다.
import { createHmac } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { PrismaClient } from "@prisma/client";

if (process.env.OBS_TEST_MODE !== "1") {
  console.error("테스트 서버 모드(OBS_TEST_MODE=1)가 아니에요. 테스트 서버에서만 시험 데이터를 넣어요.");
  process.exit(1);
}
const loginId = (process.env.SEED_SELLER_LOGIN ?? "").trim().toLowerCase();
const password = process.env.SEED_SELLER_PASSWORD ?? "";
if (!loginId || !password) {
  console.error("SEED_SELLER_LOGIN과 SEED_SELLER_PASSWORD를 실행할 때 넣어 주세요.");
  process.exit(1);
}

const hashKey = process.env.IDENTITY_HASH_KEY ?? "";
if (hashKey.length < 32) {
  console.error("IDENTITY_HASH_KEY가 없거나 너무 짧아요(32자 이상). 서버와 같은 값이 있어야 대표자 비밀번호 찾기가 돼요.");
  process.exit(1);
}
// 시험용 인물(실존 인물 아님). 휴대폰번호는 아무 번호나 넣어도 된다(CI에 들어가지 않음).
const TEST_REPRESENTATIVE = { name: "테스트대표", birth7: "9001011", birthLabel: "1990년 1월 1일, 남" };
const representativeCiHash = createHmac("sha256", hashKey).update(`fake-ci:${TEST_REPRESENTATIVE.name}:${TEST_REPRESENTATIVE.birth7}`, "utf8").digest("hex");

const db = new PrismaClient();
const SHOP = { slug: "test-shop", shopName: "테스트 쇼핑몰" };
const PRODUCTS = [
  { name: "스타라이트 부스터 박스", price: 189000, options: [["1박스 (36팩)", 0, 12], ["낱개 1팩", -183000, 260]] },
  { name: "문라이트 컬렉션 박스", price: 132000, options: [["1박스", 0, 5]] },
  { name: "탑로더 25장", price: 6000, options: [["1팩", 0, 30]] },
];

async function main() {
  if ((await db.seller.count()) > 0) {
    console.log("이미 판매자가 있어 시험 데이터를 넣지 않았어요.");
    return;
  }
  const passwordHash = await hash(password);
  // 체험 기간을 넉넉히 둬 시험 중에 쇼핑몰이 잠기지 않게 한다
  const trialEndsAt = new Date(Date.now() + 365 * 86_400_000);
  await db.$transaction(async (tx) => {
    const seller = await tx.seller.create({ data: { ...SHOP, status: "ACTIVE", approvedAt: new Date(), trialEndsAt, representativeCiHash, representativeVerifiedAt: new Date() } });
    await tx.memberGrade.createMany({
      data: [
        { sellerId: seller.id, displayName: "일반", sortOrder: 0, systemKey: "BASIC" },
        { sellerId: seller.id, displayName: "새싹", sortOrder: 1, systemKey: "SPROUT" },
        { sellerId: seller.id, displayName: "실버", sortOrder: 2, systemKey: "SILVER" },
        { sellerId: seller.id, displayName: "골드", sortOrder: 3, systemKey: "GOLD" },
        { sellerId: seller.id, displayName: "VIP", sortOrder: 4, systemKey: "VIP" },
      ],
    });
    const owner = await tx.sellerUser.create({ data: { sellerId: seller.id, email: loginId, passwordHash, name: "대표자", isOwner: true, permissions: [] } });
    for (const [i, p] of PRODUCTS.entries()) {
      const product = await tx.product.create({ data: { sellerId: seller.id, name: p.name, price: p.price, status: "ON_SALE", sortOrder: i } });
      for (const [j, [name, priceDelta, stock]] of p.options.entries()) {
        const option = await tx.productOption.create({ data: { sellerId: seller.id, productId: product.id, name, priceDelta, stock, sortOrder: j } });
        // 상품 등록(products/manage.ts)과 같이 처음 재고를 재고 이동 기록에 남긴다(재고 이력·합계가 표시 재고와 맞게)
        if (stock > 0) {
          await tx.stockMovement.create({
            data: { sellerId: seller.id, optionId: option.id, delta: stock, reason: "MANUAL", note: "처음 재고", actorType: "SELLER_USER", actorId: owner.id },
          });
        }
      }
    }
  });
  console.log(`시험 쇼핑몰을 만들었어요: ${SHOP.shopName} (/shop/${SHOP.slug}). 대표자 계정 1개, 상품 ${PRODUCTS.length}개`);
  console.log(`비밀번호 찾기 본인확인: 이름 ${TEST_REPRESENTATIVE.name}, 생년월일 ${TEST_REPRESENTATIVE.birthLabel}, 인증번호 000000`);
}

main()
  .catch((e) => {
    console.error("시험 데이터를 넣지 못했어요:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
