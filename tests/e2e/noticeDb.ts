import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 공지·FAQ e2e 준비·정리(폐기용 테스트 DB). 데모 쇼핑몰의 공지·FAQ를 지우고 시험용 글을 넣는다. 끝나면 다시 지운다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function resetNoticesInDb(slug: string, seed: boolean) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    await db.shopNotice.deleteMany({ where: { sellerId: seller.id } });
    if (!seed) return;
    const day = 86_400_000;
    await db.shopNotice.createMany({
      data: [
        { sellerId: seller.id, kind: "NOTICE", title: "10/3 (토) 20시 문라이트 브레이크 방송해요", body: "문라이트 컬렉션 박스 10박스를 순서대로 열어요.\n미리 주문하면 방송에서 먼저 열어 드려요.", isPinned: true, createdAt: new Date(Date.now() - day) },
        { sellerId: seller.id, kind: "NOTICE", title: "개천절 연휴 배송 안내", body: "10월 3일~5일은 출고가 없어요.", createdAt: new Date(Date.now() - 2 * day) },
        { sellerId: seller.id, kind: "NOTICE", title: "비공개 공지는 보이지 않아요", body: "숨김", isPublished: false },
        { sellerId: seller.id, kind: "FAQ", category: "주문 · 배송", title: "방송 중 주문하면 언제 받나요?", body: "개봉이 끝난 뒤 2영업일 안에 보내요.", sortOrder: 1 },
        { sellerId: seller.id, kind: "FAQ", category: "결제", title: "무통장 입금은 언제까지 해야 하나요?", body: "주문 뒤 10일 안에 입금해 주세요.", sortOrder: 2 },
      ],
    });
  } finally {
    await db.$disconnect();
  }
}
