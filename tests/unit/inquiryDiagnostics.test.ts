import { describe, expect, it } from "vitest";
import { parseUserAgent } from "../../lib/server/platform-inquiries/diagnostics";

describe("문의 진단 정보: User-Agent 읽기", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", { name: "Chrome", version: "126" }, { name: "Windows", version: "10/11" }, null],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.81", { name: "Edge", version: "126" }, { name: "Windows", version: "10/11" }, null],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", { name: "Safari", version: "17" }, { name: "macOS", version: "10" }, null],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1", { name: "Chrome", version: "126" }, { name: "iOS", version: "17" }, null],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", { name: "Chrome", version: "126" }, { name: "Android", version: "14" }, null],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", { name: "Firefox", version: "127" }, { name: "Linux", version: null }, null],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OBS/30.1.2", { name: "OBS 브라우저", version: "122" }, { name: "Windows", version: "10/11" }, "30.1.2"],
  ])("%s", (ua, browser, os, obsVersion) => {
    expect(parseUserAgent(ua)).toEqual({ browser, os, obsVersion });
  });

  it("없거나 모르는 값은 null", () => {
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null, obsVersion: null });
    expect(parseUserAgent("curl/8.5.0")).toEqual({ browser: null, os: null, obsVersion: null });
  });
});
