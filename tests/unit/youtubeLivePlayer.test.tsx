import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { YoutubeLivePlayer, type YoutubeLive } from "../../components/seller/broadcast/YoutubeLivePlayer";

const live: YoutubeLive = { videoId: "synthetic01", title: "합성 방송", status: "live", broadcastSessionId: "current", chatEnabled: false };
const render = (props: Partial<Parameters<typeof YoutubeLivePlayer>[0]> = {}) => renderToStaticMarkup(<YoutubeLivePlayer live={live} broadcastId="current" configured state="ready" {...props} />);

describe("현재 방송의 유튜브 플레이어", () => {
  it("현재 방송과 연결된 유효한 영상만 출력하고 자동재생을 강제하지 않는다", () => {
    const markup = render();
    expect(markup).toContain("https://www.youtube.com/embed/synthetic01?playsinline=1&amp;controls=1");
    expect(markup).toContain('title="유튜브 방송: 합성 방송"');
    expect(markup).not.toContain("autoplay");
  });
  it.each([
    { broadcastId: null },
    { broadcastId: "other" },
    { live: { ...live, broadcastSessionId: null } },
    { live: { ...live, status: "ended" } },
    { live: { ...live, videoId: 'invalid"/url' } },
    { configured: false },
    { live: null },
  ])("다른 방송·연결 누락·유효하지 않은 정보는 영상을 출력하지 않는다 (%j)", (props) => {
    const markup = render(props);
    expect(markup).not.toContain("<iframe");
    expect(markup).toContain("/seller/youtube");
  });
  it("예정 방송은 실시간 영상으로 표시하지 않는다", () => {
    const markup = render({ live: { ...live, status: "upcoming" } });
    expect(markup).not.toContain("<iframe");
    expect(markup).toContain("예정된 유튜브 방송");
  });
  it.each(["loading", "error"] as const)("%s 상태는 남아 있는 영상 정보를 재생하지 않는다", (state) => {
    expect(render({ state })).not.toContain("<iframe");
  });
});
