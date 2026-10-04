import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/html-bots";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { HTML_LIMITED_BOTS, SHARE_CRAWLER_UA } from "../../lib/shareCrawlers";

// 공유 미리보기 크롤러에는 메타데이터를 <head> 안에 고정한다(next.config htmlLimitedBots). 실제 응답은 tests/e2e/share-crawler-meta.spec.ts가 본다.
describe("htmlLimitedBots", () => {
  it("next.config가 이 목록을 쓰고, Next 기본 목록을 그대로 포함한다", () => {
    expect(nextConfig.htmlLimitedBots).toBe(HTML_LIMITED_BOTS);
    expect(HTML_LIMITED_BOTS.source.startsWith(HTML_LIMITED_BOT_UA_RE.source)).toBe(true);
    for (const ua of ["Mediapartners-Google", "Bingbot/2.0", "facebookexternalhit/1.1", "Twitterbot/1.0", "Slackbot-LinkExpanding 1.0", "Discordbot/2.0", "WhatsApp/2.23"]) {
      expect(HTML_LIMITED_BOTS.test(ua), ua).toBe(true);
    }
  });

  it("카카오톡·다음·네이버·텔레그램 등 공유 크롤러 UA를 잡고, 일반 브라우저는 잡지 않는다", () => {
    for (const ua of [
      "kakaotalk-scrap/1.0; +https://devtalk.kakao.com/docs/latest/kakaotalk-link",
      "Mozilla/5.0 (compatible; Daum/4.1; +http://cs.daum.net/faq/15/4118.html)",
      "Mozilla/5.0 (compatible; Daumoa/4.0)",
      "Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)",
      "TelegramBot (like TwitterBot)",
      "Pinterest/0.2 (+https://www.pinterest.com/bot.html)",
    ]) {
      expect(HTML_LIMITED_BOTS.test(ua), ua).toBe(true);
    }
    expect(SHARE_CRAWLER_UA.length).toBeGreaterThan(0);
    for (const ua of [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ]) {
      expect(HTML_LIMITED_BOTS.test(ua), ua).toBe(false);
    }
  });
});
