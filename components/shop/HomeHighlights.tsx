import Link from "next/link";
import { kstDate } from "./kstDate";

// SH-001 홈의 히어로 옆 카드 셋과 「이번 주 인기 카드」 표(보드 SH-001-PC-IA · SH-001). 값은 GET /api/shop/[slug]/home/highlights와 같은 서버 값이다.
// 다음 방송 일정 · 「남은 자리」 · 「방송 시작 알림 받기」는 서버 값이 없어 그리지 않는다(docs/UI_STATUS.md).
export type HomeHighlights = {
  weeklyHits: { rank: number; nickname: string; cardName: string; grade: string | null; createdAt: Date }[];
  hero: {
    benefit: { maxRewardRate: number | null; gradeRefresh: { cadence: "MONTHLY" | "WEEKLY" | "DAILY"; nextRunAt: Date } | null };
    hit: { weekCount: number };
    notice: { id: string; title: string; isPinned: boolean; createdAt: Date } | null;
  };
};

const kstParts = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(5, 10).split("-");
const mmdd = (d: Date) => kstParts(d).join(".");

function refreshText(r: NonNullable<HomeHighlights["hero"]["benefit"]["gradeRefresh"]>) {
  if (r.cadence === "MONTHLY") return `등급은 매달 ${Number(kstParts(r.nextRunAt)[1])}일 갱신`;
  return r.cadence === "WEEKLY" ? "등급은 매주 갱신" : "등급은 매일 갱신";
}

export function HeroSide({ base, hero, withBanner }: { base: string; hero: HomeHighlights["hero"]; withBanner: boolean }) {
  const { benefit, notice } = hero;
  const benefitSub = [benefit.maxRewardRate ? `최대 ${benefit.maxRewardRate}% 적립` : null, benefit.gradeRefresh ? refreshText(benefit.gradeRefresh) : null].filter(Boolean).join(" · ");
  return (
    <div className={`shop-hero-side${withBanner ? "" : " is-solo"}`}>
      <div>
        <span className="k">회원 혜택</span>
        <b>등급이 오를수록 커지는 혜택</b>
        {benefitSub && <span className="sub">{benefitSub}</span>}
      </div>
      <a href="#home-hits">
        <span className="k">인기 카드</span>
        <b>이번 주 HIT 카드</b>
        <span className="sub">방송에서 나온 당첨 카드를 모아 봐요</span>
      </a>
      {notice && (
        <Link href={`${base}/help/notices/${notice.id}`}>
          <span className="k">공지</span>
          <b>{notice.title}</b>
          <span className="sub">{kstDate(notice.createdAt)}</span>
        </Link>
      )}
    </div>
  );
}

export function WeeklyHits({ hits }: { hits: HomeHighlights["weeklyHits"] }) {
  return (
    <section className="shop-sec shop-home-hits" id="home-hits" aria-labelledby="home-hits-title">
      <div className="shop-sec-head">
        <h2 id="home-hits-title">이번 주 인기 카드</h2>
        <span className="shop-home-sub">당첨 카드 기준</span>
      </div>
      {hits.length === 0 ? (
        <p className="shop-empty">이번 주 나온 HIT 카드가 아직 없어요.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">순위</th>
              <th scope="col">닉네임</th>
              <th scope="col">당첨 카드</th>
              <th scope="col">날짜</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h) => (
              <tr key={h.rank} className={h.rank === 1 ? "is-top" : undefined}>
                <td>
                  <b>{h.rank}</b>
                </td>
                <td className="l">
                  <b>{h.nickname}</b>
                </td>
                <td className="l">{h.cardName}</td>
                <td className="r">{mmdd(h.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
