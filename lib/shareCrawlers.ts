import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/html-bots";

// 링크 공유 미리보기 크롤러(카카오톡·네이버·다음·페이스북·X·슬랙·디스코드·텔레그램 등).
// Next 16은 일반 요청에 메타데이터를 흘려보내(streaming) og 메타가 <head> 밖(body)에 붙을 수 있다. 이 크롤러들은 <head>만 읽으므로
// next.config의 htmlLimitedBots에 넣어 메타데이터를 <head> 안에 고정한다. htmlLimitedBots는 Next 기본 목록을 대신하므로 기본 목록을 함께 둔다.
export const SHARE_CRAWLER_UA = [
  "kakaotalk-scrap", // 카카오톡
  "Yeti", // 네이버
  "Daum", // 다음(Daum, Daumoa)
  "facebookexternalhit",
  "Facebot",
  "Twitterbot",
  "Slackbot",
  "Slack-ImgProxy",
  "Discordbot",
  "TelegramBot",
  "LinkedInBot",
  "WhatsApp",
  "Pinterest",
] as const;

export const HTML_LIMITED_BOTS = new RegExp(`${HTML_LIMITED_BOT_UA_RE.source}|${SHARE_CRAWLER_UA.join("|")}`, "i");
