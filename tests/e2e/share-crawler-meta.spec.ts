import { expect, test } from "@playwright/test";

// 공유 미리보기 크롤러 요청에는 og 메타가 <head> 안에 있어야 한다(next.config htmlLimitedBots, lib/shareCrawlers.ts).
// Next 16은 일반 요청에 메타데이터를 흘려보내 <head> 밖에 붙일 수 있고, 카카오톡·다음은 Next 기본 봇 목록에 없다.
const CRAWLERS = [
  "kakaotalk-scrap/1.0; +https://devtalk.kakao.com/docs/latest/kakaotalk-link",
  "Mozilla/5.0 (compatible; Daum/4.1; +http://cs.daum.net/faq/15/4118.html)",
  "Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Twitterbot/1.0",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  "TelegramBot (like TwitterBot)",
];

for (const ua of CRAWLERS) {
  test(`공유 크롤러(${ua.slice(0, 40)})에는 og:title이 <head> 안에 있다`, async ({ request }) => {
    const html = await (await request.get("/seller/login", { headers: { "user-agent": ua } })).text();
    const og = html.indexOf('property="og:title"');
    expect(og, "og:title").toBeGreaterThan(-1);
    expect(og, "</head> 앞").toBeLessThan(html.indexOf("</head>"));
  });
}
