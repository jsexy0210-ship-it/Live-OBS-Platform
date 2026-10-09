"use client";

import "../../../styles/seller-broadcast.css";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../api";
import { type BroadcastSummary } from "../broadcast/history";
import { formatTime, ago } from "../../../lib/client/format";
import type { Snapshot } from "../broadcast/queue";
import { useSeller } from "../SellerShell";

// SA-002-O 오버레이 전용 홈(FINAL v320). 머리 「홈 · 오버레이 전용」과 오른쪽 버튼(방송 대시보드 · 방송 화면 꾸미기),
// 상태 3칸(외부 쇼핑몰 · 오늘 들어온 주문 · 방송 화면), 왼쪽 「지금 방송」, 오른쪽 「스토어 메뉴는 쇼핑몰 통합에서 열립니다」 안내.
// 서버가 주는 값만 보인다: 주문대기·지금 방송(GET /api/seller/queue)·방송 요약(…/broadcast/summary)·외부 쇼핑몰(…/external-shops, 쇼핑몰 설정 권한이 있을 때).
// 체험 남은 일수 띠는 화면 위 공통 띠(SellerShell)가 이미 보여 여기서 다시 만들지 않는다. 못 읽은 값·서버에 아직 없는 값은 「-」로 둔다
// (자동 연결 완료 안내 · 통합 요금은 서버 값이 생기면 붙인다).

type Summary = { broadcast: { id: string; title: string | null; status: "live" | "ended"; startedAt: string; endedAt: string | null } | null; summary: BroadcastSummary };
type Info = { lastAccessAt: string | null; lastClient: string | null; connected: boolean };
type Shops = { connections: { id: string; status: string; lastEventAt: string | null }[] };

export function OverlayHomeSections() {
  const { can } = useSeller();
  const run = can("BROADCAST_RUN");
  const shopRead = can("SHOP_SETTINGS");
  const ovEdit = can("OVERLAY_EDIT");
  const [queue, setQueue] = useState<Snapshot | null>(null);
  const [sum, setSum] = useState<Summary | null>(null);
  const [shops, setShops] = useState<Shops | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    if (run) {
      void api<Snapshot>("/api/seller/queue").then((r) => live && setQueue(r.ok ? r.data : null));
      void api<Summary>("/api/seller/broadcast/summary").then((r) => live && setSum(r.ok ? r.data : null));
    }
    if (ovEdit) void api<Info>("/api/seller/overlay/address-info").then((r) => live && setInfo(r.ok ? r.data : null));
    if (shopRead) void api<Shops>("/api/seller/external-shops").then((r) => live && setShops(r.ok ? r.data : null));
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [run, shopRead, ovEdit]);

  const waiting = queue ? queue.waiting.length + queue.beforeBroadcast.length : null;
  const onAir = queue?.broadcast ?? null;
  const connected = shops?.connections.filter((c) => c.status === "CONNECTED") ?? [];
  const lastEvent = connected.map((c) => c.lastEventAt).filter((v): v is string => !!v).sort().at(-1) ?? null;
  const minutes = onAir ? Math.max(0, Math.floor((now - new Date(onAir.startedAt).getTime()) / 60_000)) : 0;
  const since = minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분째` : `${minutes}분째`;

  return (
    <section className="col" style={{ gap: 16 }} aria-label="오버레이 이용 현황">

      <div className="bc-sum-g" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }} data-testid="oh-tiles">
        <div className="stat" data-testid="oh-shop">
          <span className="t-l2 c-alt">외부 쇼핑몰</span>
          {shopRead ? (
            shops ? (
              connected.length > 0 ? (
                <>
                  <span className="v">
                    <span className="bdg b-done">연결됨</span>
                  </span>
                  <span className="t-c1 c-alt">{lastEvent ? `마지막 주문 이벤트 ${ago(lastEvent, now)}` : "아직 받은 주문 이벤트가 없습니다"}</span>
                </>
              ) : (
                <>
                  <span className="v">연결 안 됨</span>
                  <Link className="t-c1" href="/seller/external-shops">
                    외부 쇼핑몰 연결하기
                  </Link>
                </>
              )
            ) : (
              <span className="v">-</span>
            )
          ) : (
            <span className="v">-</span>
          )}
        </div>
        <div className="stat" data-testid="oh-orders">
          <span className="t-l2 c-alt">오늘 들어온 주문</span>
          <span className="v">{sum ? `${sum.summary.orders.toLocaleString("ko-KR")}건` : "-"}</span>
          <span className="t-c1 c-alt">{sum && waiting !== null ? `주문대기 ${waiting}건 · 개봉 완료 ${sum.summary.completed}건` : ""}</span>
        </div>
        <div className="stat" data-testid="oh-screen">
          <span className="t-l2 c-alt">방송 화면</span>
          <span className="v">{info?.lastAccessAt ? (info.connected ? "연결됨" : "연결 끊김") : "-"}</span>
          <span className="t-c1 c-alt">{info?.lastAccessAt ? `${info.lastClient ?? "방송 프로그램"} · ${info.connected ? "지금 연결 중" : `마지막 접속 ${ago(info.lastAccessAt, now)}`}` : info ? "아직 접속한 적이 없습니다" : ""}</span>
        </div>
      </div>

      <div className="row" style={{ gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="col" style={{ gap: 12, flex: "1 1 420px", minWidth: 0 }}>
          {run && (
            <section className="col" style={{ gap: 8 }} aria-labelledby="oh-live-h" data-testid="oh-live">
              <h2 className="t-hl1" id="oh-live-h">
                지금 방송
              </h2>
              <div className="card pad col" style={{ gap: 4 }}>
                {onAir ? (
                  <>
                    <span className="row" style={{ gap: 8 }}>
                      <span className="bdg b-live">LIVE</span>
                      <b>{onAir.title || "제목 없는 방송"}</b>
                    </span>
                    <span className="t-c1 c-alt">
                      {formatTime(onAir.startedAt)} 시작 · {since} · 주문대기 {waiting ?? 0}건{queue?.opening ? ` · 개봉 중 ${queue.opening.nicknameSnapshot}` : ""}
                    </span>
                  </>
                ) : (
                  <span className="t-l2 c-alt">{queue ? "지금 방송 중이 아닙니다" : "-"}</span>
                )}
              </div>
            </section>
          )}
        </div>

        <section className="col" style={{ gap: 8, flex: "1 1 420px", minWidth: 0 }} aria-labelledby="oh-up-h" data-testid="oh-upgrade">
          <h2 className="t-hl1" id="oh-up-h">
            스토어 메뉴는 쇼핑몰 통합에서 열립니다
          </h2>
          <div className="card pad col" style={{ gap: 8 }}>
            <span className="t-c1 c-alt">ONQ 스토어를 열면 상품 · 주문 · 배송까지 여기서 관리합니다</span>
            <ul style={{ margin: "0 0 0 16px", padding: 0, lineHeight: "20px" }}>
              <li>ONQ 스토어 · 상품 · 주문 운영</li>
              <li>결제 · 배송 · 송장 · 적립금</li>
              <li>영수증 · 세금계산서 발행</li>
              <li>지금 연결한 외부 쇼핑몰은 그대로 유지</li>
            </ul>
            <span className="t-c1 c-alt">쇼핑몰까지 쓰는 이용권(통합 구독)의 요금은 이용권 화면에서 확인합니다.</span>
            <div>
              <Link className="btn" href="/seller/subscription">
                쇼핑몰 통합으로 바꾸기
              </Link>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
