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
  await seedOrders(seller.id, passwordHash);
  console.log(`데모 판매자를 준비했어요 (DB: ${dbName})`);
  console.log(`  대표자: ${users[0].email}`);
  console.log(`  상품 담당 직원: ${users[1].email}`);
  console.log(`  상품 권한 없는 직원: ${users[2].email}`);
  console.log(`  권한 0개 직원: ${users[3].email}`);
  console.log(`  비밀번호(네 계정 같음): ${password}`);
}

// 판매자 주문 화면(SA-021·022·023)용 데모 구매자·주문. 주문이 하나도 없을 때만 만든다(다시 돌려도 늘지 않음).
// 최근 주문부터: 결제 완료(발송 전)·결제 완료(발송함)·결제 대기·환불됨·취소가 섞인 25건(목록 20건씩 → 「더 불러오기」 확인용).
async function seedOrders(sellerId, passwordHash) {
  if ((await db.order.count({ where: { sellerId } })) > 0) return;
  const grade = await db.memberGrade.findFirst({ where: { sellerId }, orderBy: { sortOrder: "asc" } });
  const options = await db.productOption.findMany({
    // 데모 상품만(e2e가 만든 상품·지운 상품 제외)
    where: { sellerId, product: { status: "ON_SALE", deletedAt: null, name: { in: PRODUCTS.map((p) => p.name) } } },
    include: { product: { select: { name: true, price: true } } },
    orderBy: [{ product: { sortOrder: "asc" } }, { sortOrder: "asc" }],
  });
  // 데모 상품이 없으면(이미 있던 DB에서 상품을 지웠거나 바꾼 경우) 주문을 만들 수 없다. 건너뛰고 알린다.
  if (options.length === 0 || !grade) {
    console.log("데모 상품이나 회원 등급이 없어 데모 주문은 만들지 않았어요");
    return;
  }
  const buyers = [];
  for (const [i, nick] of ["별빛사냥꾼", "카드왕", "민트컨디션"].entries()) {
    const loginId = `demo-buyer${i + 1}@example.com`;
    buyers.push(
      (await db.buyerMember.findFirst({ where: { sellerId, loginId, deletedAt: null } })) ??
      await db.buyerMember.create({
        data: {
          sellerId,
          loginId,
          passwordHash,
          name: `데모구매자${i + 1}`,
          phone: `0109000000${i + 1}`,
          ciHash: `demo-ci-${i + 1}`,
          identityVerifiedAt: new Date(),
          birthDate: new Date("1995-05-05"),
          broadcastNickname: nick,
          gradeId: grade.id,
        },
      }),
    );
  }
  const now = Date.now();
  for (let n = 25; n >= 1; n--) {
    // n이 클수록 최근 주문(orderNo도 큼). 맨 위 두 건은 결제 완료(발송 전)·결제 완료(발송함)
    const age = 25 - n; // 0이 가장 최근
    const status = age <= 1 ? "PAID" : age % 7 === 2 ? "PENDING_PAYMENT" : age % 7 === 4 ? "REFUNDED" : age % 11 === 6 ? "CANCELLED" : "PAID";
    const shipped = status === "PAID" && (age === 1 || age % 3 === 0) && age !== 0;
    const opt = options[age % options.length];
    const qty = (age % 3) + 1;
    const unitPrice = opt.product.price + opt.priceDelta;
    const total = unitPrice * qty;
    const buyer = buyers[age % buyers.length];
    const createdAt = new Date(now - age * 7 * 3600_000 - 10 * 60_000);
    const paid = status !== "PENDING_PAYMENT";
    const order = await db.order.create({
      data: {
        sellerId,
        orderNo: n,
        buyerMemberId: buyer.id,
        status,
        broadcastNicknameSnapshot: buyer.broadcastNickname,
        totalAmount: total,
        paymentMethod: age % 4 === 3 ? "BANK_TRANSFER" : "CARD",
        createdAt,
        paidAt: paid ? new Date(createdAt.getTime() + 60_000) : null,
        paymentDueAt: new Date(createdAt.getTime() + 24 * 3600_000),
        cancelledAt: status === "CANCELLED" ? new Date(createdAt.getTime() + 3600_000) : null,
        refundedAt: status === "REFUNDED" ? new Date(createdAt.getTime() + 3600_000) : null,
        refundAmount: status === "REFUNDED" ? total : null,
        refundFault: status === "REFUNDED" ? "BUYER" : null,
      },
    });
    await db.orderItem.create({
      data: {
        sellerId,
        orderId: order.id,
        productId: opt.productId,
        optionId: opt.id,
        productNameSnapshot: opt.product.name,
        optionNameSnapshot: opt.name,
        unitPrice,
        quantity: qty,
        createdAt,
      },
    });
    await db.orderShippingAddress.create({
      data: { sellerId, orderId: order.id, recipientName: buyer.name, phone: buyer.phone, zipCode: "06236", address1: "서울 강남구 테헤란로 1", address2: "101호" },
    });
    if (shipped) {
      await db.shipment.create({
        data: { sellerId, orderId: order.id, courier: "CJ대한통운", trackingNumber: `5600000000${String(n).padStart(2, "0")}`, shippedAt: new Date(createdAt.getTime() + 3 * 3600_000) },
      });
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
