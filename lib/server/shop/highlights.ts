import type { PrismaClient } from "@prisma/client";
import { shopOpen } from "../buyers/signup";
import { nextRunAt, type Cadence } from "../shop-member-grades/rules";
import { overlayNickname } from "../overlay/state";

// 구매자 쇼핑몰 홈(SH-001)의 공개 데이터(로그인 없이):
// - weeklyHits(「이번 주 인기 카드」 표): 지금부터 7일 안에 기록된 HIT 카드를 최신순 5장. 순위는 그 순서(1부터), 닉네임은 방송 화면과 같은 정리 규칙(overlayNickname), 구매자 이름·주문 정보는 내보내지 않는다.
// - hero(히어로 옆 카드 셋): 혜택(등급별 적립률 중 가장 큰 값 maxRewardRate(%)와 등급 자동 갱신 주기, 설정이 없으면 null), HIT(이번 주 카드 수 weekCount), 공지(고정 공지, 없으면 가장 최근 공개 공지, 없으면 null).
// 운영 중이 아니거나 스토어 운영 권한이 없는 쇼핑몰은 null(404).
export const HOME_HIT_WINDOW_MS = 7 * 86_400_000;
export const HOME_HIT_ROWS = 5;

type Rates = Record<string, { card?: number | null; bankTransfer?: number | null } | undefined>;

export async function shopHomeHighlights(db: PrismaClient, slug: string, now = new Date()) {
  const shop = await db.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  const sellerId = shop.id;
  const since = new Date(now.getTime() - HOME_HIT_WINDOW_MS);
  const hitWhere = { sellerId, createdAt: { gte: since, lte: now } };
  const noticeWhere = { sellerId, kind: "NOTICE" as const, isPublished: true };
  const noticeSelect = { id: true, title: true, isPinned: true, createdAt: true };
  const [hits, weekCount, pinned, latest, grades, reward, gradePolicy] = await Promise.all([
    db.hitCard.findMany({ where: hitWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: HOME_HIT_ROWS, select: { id: true, cardName: true, grade: true, nicknameSnapshot: true, createdAt: true } }),
    db.hitCard.count({ where: hitWhere }),
    db.shopNotice.findFirst({ where: { ...noticeWhere, isPinned: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: noticeSelect }),
    db.shopNotice.findFirst({ where: noticeWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: noticeSelect }),
    db.memberGrade.findMany({ where: { sellerId }, select: { id: true } }),
    db.rewardPolicy.findUnique({ where: { sellerId }, select: { rates: true } }),
    db.memberGradePolicy.findUnique({ where: { sellerId }, select: { autoEnabled: true, cadence: true } }),
  ]);
  // 지금 있는 등급의 적립률(카드·무통장) 중 가장 큰 값. 설정이 없거나 전부 0이면 null.
  const rates = (reward?.rates && typeof reward.rates === "object" ? reward.rates : {}) as Rates;
  const values = grades.flatMap((g) => [rates[g.id]?.card, rates[g.id]?.bankTransfer]).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  const cadence = gradePolicy?.autoEnabled ? (gradePolicy.cadence as Cadence) : null;
  const notice = pinned ?? latest;
  return {
    weeklyHits: hits.map((h, i) => ({ rank: i + 1, nickname: overlayNickname(h.nicknameSnapshot), cardName: h.cardName, grade: h.grade, createdAt: h.createdAt })),
    hero: {
      benefit: { maxRewardRate: values.length > 0 ? Math.max(...values) : null, gradeRefresh: cadence ? { cadence, nextRunAt: nextRunAt(cadence, now) } : null },
      hit: { weekCount },
      notice: notice ? { id: notice.id, title: notice.title, isPinned: notice.isPinned, createdAt: notice.createdAt } : null,
    },
  };
}
