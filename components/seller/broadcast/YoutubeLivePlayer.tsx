import Link from "next/link";

export type YoutubeLive = {
  videoId: string;
  title: string;
  status: string;
  broadcastSessionId: string | null;
  chatEnabled: boolean;
};

export function YoutubeLivePlayer({ live, broadcastId, configured, state }: {
  live: YoutubeLive | null;
  broadcastId: string | null;
  configured: boolean;
  state: "loading" | "ready" | "error";
}) {
  const validId = live !== null && /^[A-Za-z0-9_-]{11}$/.test(live.videoId);
  const current = configured && validId && live.status === "live" && broadcastId !== null && live.broadcastSessionId === broadcastId;
  const notice = state === "loading" ? "유튜브 연결을 불러오는 중입니다."
    : state === "error" ? "유튜브 연결을 불러오지 못했습니다. 잠시 뒤 다시 확인해 주십시오."
      : !configured || !live ? "연결된 유튜브 방송이 없습니다. 유튜브 연결에서 방송을 선택해 주십시오."
        : !validId ? "연결된 영상 정보를 확인할 수 없습니다. 유튜브 연결을 확인해 주십시오."
          : live.status === "upcoming" ? "예정된 유튜브 방송입니다. 방송이 시작되면 화면을 표시합니다."
            : !current ? "현재 방송과 연결된 유튜브 실시간 화면이 없습니다. 유튜브 연결을 확인해 주십시오."
              : null;
  return (
    <section className="card pad col bc-youtube" style={{ gap: 10 }} aria-labelledby="bc-youtube-h">
      <h2 className="t-hl2" id="bc-youtube-h">유튜브 실시간 화면</h2>
      {state === "ready" && current && live ? (
        <>
          <iframe
            key={live.videoId}
            title={live.title ? `유튜브 방송: ${live.title}` : "연결된 유튜브 방송"}
            src={`https://www.youtube.com/embed/${live.videoId}?playsinline=1&controls=1`}
            allow="encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            data-testid="bc-youtube-player"
          />
          <span className="t-c1 c-alt">재생 버튼을 눌러 확인해 주십시오. 영상 공개 상태와 유튜브 재생 제한에 따라 표시되지 않을 수 있습니다.</span>
          <a className="btn btn-sm btn-out" href={`https://www.youtube.com/watch?v=${live.videoId}`} target="_blank" rel="noopener noreferrer">유튜브에서 보기</a>
        </>
      ) : <span className="t-c1 c-alt" role="status" data-testid="bc-youtube-notice">{notice}</span>}
      <Link className="btn btn-sm btn-out" href="/seller/youtube">유튜브 연결</Link>
    </section>
  );
}
