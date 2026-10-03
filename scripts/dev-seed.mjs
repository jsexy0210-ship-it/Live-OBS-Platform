// 판매자 화면을 눌러 보기 위한 데모 데이터. 폐기용 DB(이름이 _test로 끝나는 DB)에만 넣는다. 운영 DB에는 절대 쓰지 않는다.
// 실행: DATABASE_URL=postgresql://…/xxx_test node scripts/dev-seed.mjs
// 비밀번호는 DEV_SEED_PASSWORD가 있으면 그 값, 없으면 실행할 때마다 새로 만들어 화면에만 출력한다(문서·저장소에 남기지 않는다).
import { randomBytes } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL;
const dbName = url ? decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) : "";
if (process.env.NODE_ENV === "production") {
  console.error("운영 모드(NODE_ENV=production)에서는 데모 데이터를 넣지 않아요. 개발용 터미널에서 폐기용 DB로 실행해 주세요.");
  process.exit(1);
}
if (!dbName.endsWith("_test")) {
  console.error(`폐기용 DB가 아니에요(DB 이름: ${dbName || "없음"}). 이름이 _test로 끝나는 DB에만 데모 데이터를 넣어요.`);
  process.exit(1);
}

const password = process.env.DEV_SEED_PASSWORD || randomBytes(9).toString("base64url");
const db = new PrismaClient();

// 첫 상품은 짧은 이름(1줄), 다섯째는 100자 이름 — 줄 맞춤을 함께 확인한다
const PRODUCTS = [
  { name: "스타라이트 부스터 박스", price: 189000, status: "ON_SALE", options: [["1박스 (36팩)", 0, 12], ["낱개 1팩", -183000, 260]] },
  { name: "문라이트 컬렉션 박스", price: 132000, status: "ON_SALE", options: [["1박스", 0, 5]] },
  { name: "드래곤 소울 부스터", price: 15000, status: "SOLD_OUT", options: [["1팩", 0, 0]] },
  { name: "탑로더 25장", price: 6000, status: "ON_SALE", options: [["1팩", 0, 3]] },
  {
    // 100자(최대 길이) 이름: 목록·카드 3줄 말줄임 확인용
    name: "포켓몬 카드 게임 스칼렛 바이올렛 확장팩 레이징 서프 부스터 박스 30팩 세트 한글판 정품 미개봉 초회 생산 한정 프로모 카드 1장 동봉 특별 사은품 증정 2026 한정 추가 구성",
    price: 54000,
    status: "ON_SALE",
    options: [["1박스", 0, 40]],
  },
  { name: "문라이트 1탄 박스", price: 132000, status: "HIDDEN", options: [["1박스", 0, 0]] },
  { name: "카드 슬리브 100매", price: 4500, status: "DRAFT", options: [["투명", 0, 320], ["블랙", 500, 120]] },
  // 옵션 이름이 길고 많은 상품: 목록 표가 넘치지 않는지 확인용
  {
    name: "보관용 카드 바인더",
    price: 18000,
    status: "ON_SALE",
    options: [
      ["9포켓 바인더 (블랙 · 사이드 로딩 · 360장 수납 · 지퍼 케이스 포함)", 0, 20],
      ["9포켓 바인더 (화이트 · 사이드 로딩 · 360장 수납 · 지퍼 케이스 포함)", 0, 15],
      ["4포켓 바인더 (네이비 · 톱 로딩 · 160장 수납)", -4000, 30],
      ["12포켓 대용량 바인더 (그레이 · 480장 수납 · 손잡이 달린 하드 케이스)", 6000, 8],
    ],
  },
];

async function main() {
  const passwordHash = await hash(password);
  const trialEndsAt = new Date(Date.now() + 10 * 86_400_000);
  const seller = await db.seller.upsert({
    where: { slug: "demo-shop" },
    update: { status: "ACTIVE", trialEndsAt },
    create: { slug: "demo-shop", shopName: "카드숍 별빛", status: "ACTIVE", approvedAt: new Date(), trialEndsAt },
  });
  // 회원 등급: 실제 판매자는 입점 신청 때 만든다(lib/server/sellers/application.ts). 없으면 구매자 가입이 shop_unavailable로 막힌다.
  await db.memberGrade.createMany({
    data: [
      { sellerId: seller.id, displayName: "일반", sortOrder: 0, systemKey: "BASIC" },
      { sellerId: seller.id, displayName: "새싹", sortOrder: 1, systemKey: "SPROUT" },
      { sellerId: seller.id, displayName: "실버", sortOrder: 2, systemKey: "SILVER" },
      { sellerId: seller.id, displayName: "골드", sortOrder: 3, systemKey: "GOLD" },
      { sellerId: seller.id, displayName: "VIP", sortOrder: 4, systemKey: "VIP" },
    ],
    skipDuplicates: true,
  });
  const users = [
    { email: "demo-owner@example.com", name: "대표자", isOwner: true, permissions: [] },
    { email: "demo-staff@example.com", name: "상품 담당 직원", isOwner: false, permissions: ["PRODUCT_MANAGE"] },
    { email: "demo-viewer@example.com", name: "배송 담당 직원", isOwner: false, permissions: ["ORDER_SHIPPING"] },
    { email: "demo-none@example.com", name: "권한 없는 직원", isOwner: false, permissions: [] },
  ];
  for (const u of users) {
    await db.sellerUser.upsert({
      where: { sellerId_email: { sellerId: seller.id, email: u.email } },
      update: { passwordHash, status: "ACTIVE", credentialVersion: { increment: 1 } },
      create: { sellerId: seller.id, passwordHash, ...u },
    });
  }
  if ((await db.product.count({ where: { sellerId: seller.id } })) === 0) {
    for (const [i, p] of PRODUCTS.entries()) {
      const product = await db.product.create({ data: { sellerId: seller.id, name: p.name, price: p.price, status: p.status, sortOrder: i } });
      for (const [j, [name, priceDelta, stock]] of p.options.entries()) {
        await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name, priceDelta, stock, sortOrder: j } });
      }
    }
  }
  console.log(`데모 판매자를 준비했어요 (DB: ${dbName})`);
  console.log(`  대표자: ${users[0].email}`);
  console.log(`  상품 담당 직원: ${users[1].email}`);
  console.log(`  상품 권한 없는 직원: ${users[2].email}`);
  console.log(`  권한 0개 직원: ${users[3].email}`);
  console.log(`  비밀번호(네 계정 같음): ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
