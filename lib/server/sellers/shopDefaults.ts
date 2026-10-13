import type { Prisma } from "@prisma/client";
import { DEFAULT_SECTIONS } from "../shop-display/service";

// 쇼핑몰이 만들어질 때 설정 행을 기본값으로 만든다(대표님 지시 2026-10-06 「파트너스 쇼핑몰 가입 시 디폴트 값 지정」).
// 값은 칼럼 기본값(prisma/schema.prisma)을 그대로 쓴다. 읽는 쪽 코드의 폴백과 같은 값이라 동작은 바뀌지 않고, 행이 있다는 점만 다르다.
// 항목·값·근거는 docs/SHOP_DEFAULTS.md 표 한 곳. 이미 행이 있으면 건드리지 않는다(skipDuplicates).
// 근거가 없는 값(등급별 적립률·승급 기준 금액·약관·사업장 정보 등)과 부작용이 있는 RewardPolicy는 만들지 않는다.
export async function createShopDefaults(tx: Prisma.TransactionClient, sellerId: string): Promise<void> {
  const one = [{ sellerId }];
  await tx.sellerShippingPolicy.createMany({ data: one, skipDuplicates: true });
  await tx.sellerOrderPolicy.createMany({ data: one, skipDuplicates: true });
  await tx.sellerMemberPolicy.createMany({ data: one, skipDuplicates: true });
  await tx.sellerOrderNotificationPolicy.createMany({ data: one, skipDuplicates: true });
  await tx.productReviewPolicy.createMany({ data: one, skipDuplicates: true });
  await tx.shopSeo.createMany({ data: one, skipDuplicates: true });
  await tx.memberGradePolicy.createMany({ data: one, skipDuplicates: true });
  await tx.youtubeSellerSetting.createMany({ data: one, skipDuplicates: true });
  // 진열: 설정 행과 기본 영역은 함께 만든다(이미 설정을 저장한 쇼핑몰이면 아무것도 하지 않는다)
  const had = await tx.shopDisplaySetting.findUnique({ where: { sellerId }, select: { sellerId: true } });
  if (!had) {
    await tx.shopDisplaySetting.create({ data: { sellerId } });
    await tx.shopDisplaySection.createMany({ data: DEFAULT_SECTIONS.map((s, i) => ({ sellerId, kind: s.kind, categoryId: s.categoryId, title: s.title, visible: s.visible, itemCount: s.itemCount, sortOrder: i })) });
  }
}
