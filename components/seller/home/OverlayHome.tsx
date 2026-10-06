"use client";

import "../../../styles/seller-broadcast.css";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHead } from "../../admin-ui";
import { api } from "../api";
import { kstDuration, type BroadcastSummary } from "../broadcast/history";
import { formatDateTime } from "../../../lib/client/format";
import type { Snapshot } from "../broadcast/queue";
import { won } from "../format";
import { useSeller } from "../SellerShell";

// SA-002-O 오버레이 전용 홈. 파트너스 홈 순서(업무 → 성과 → 방송)에서 스토어 업무(입금·배송·문의·재고)는 요금제에 없어 빼고,
// 스토어 메뉴 자리에 통합 구독 안내를 둔다. 서버가 주는 값만 보인다: 주문대기(GET /api/seller/queue)·방송 요약(…/broadcast/summary)·최근 방송(…/broadcast/history).
// 체험 남은 일수 배너는 화면 위 공통 띠(SellerShell)가 이미 보여 여기서 다시 만들지 않는다. 못 읽은 값은 「-」로 둔다.

type Summary = { broadcast: { id: string; title: string | null; status: "live" | "ended"; startedAt: string; endedAt: string | null } | null; summary: BroadcastSummary };
type Recent = { id: string; title: string | null; status: "live" | "ended"; startedAt: string; endedAt: string | null; summary: BroadcastSummary };

export function OverlayHome() {
  const { can } = useSeller();
  const run = can("BROADCAST_RUN");
  const [queue, setQueue] = useState<Snapshot | null>(null);
  const [sum, setSum] = useState<Summary | null>(null);
  const [recent, setRecent] = useState<Recent[] | null>(null);

  useEffect(() => {
    if (!run) return;
    let live = true;
    void api<Snapshot>("/api/seller/queue").then((r) => live && setQueue(r.ok ? r.data : null));
    void api<Summary>("/api/seller/broadcast/summary").then((r) => live && setSum(r.ok ? r.data : null));
    void api<{ items: Recent[] }>("/api/seller/broadcast/history").then((r) => live && setRecent(r.ok ? r.data.items.slice(0, 3) : null));
    return () => {
      live = false;
    };
  }, [run]);

  const waiting = queue ? queue.waiting.length + queue.beforeBroadcast.length : null;
  const onAir = queue?.broadcast != null;

  return (
    <main className="main">
      <PageHead title="홈" />

      {run && (
        <>
          <section className="card pad-l" aria-label="오늘 처리할 일" data-testid="oh-todo">
            <h2 className="t-t3">오늘 처리할 일</h2>
            <p className="t-c1 c-alt">주문대기: 방송 중 들어온 주문을 순서대로 모아 둔 목록입니다.</p>
            <div className="bc-sum-g">
              <Tile label="주문대기" value={waiting === null ? "-" : `${waiting.toLocaleString("ko-KR")}건`} href="/seller/broadcast" />
              <Tile label="방송 상태" value={queue ? (onAir ? "방송 중" : "방송 전") : "-"} href="/seller/broadcast" />
            </div>
          </section>

          <section className="card pad-l" aria-label="성과" data-testid="oh-perf">
            <h2 className="t-t3">{sum?.broadcast ? (sum.broadcast.status === "live" ? "지금 방송 성과" : "오늘 마지막 방송 성과") : "오늘 방송 성과"}</h2>
            <div className="bc-sum-g">
              <Tile label="주문" value={sum ? `${sum.summary.orders.toLocaleString("ko-KR")}건` : "-"} />
              <Tile label="매출" value={sum ? won(sum.summary.sales) : "-"} />
              <Tile label="완료 / 취소" value={sum ? `${sum.summary.completed} / ${sum.summary.cancelled}` : "-"} />
              <Tile label="HIT 카드" value={sum ? `${sum.summary.hits}장` : "-"} />
            </div>
          </section>
        </>
      )}

      <section className="card pad-l" aria-label="방송" data-testid="oh-broadcast">
        <h2 className="t-t3">방송</h2>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {run && (
            <Link className="btn" href="/seller/broadcast">
              방송 대시보드
            </Link>
          )}
          {can("OVERLAY_EDIT") && (
            <Link className="btn btn-out" href="/seller/overlay">
              방송 화면 꾸미기
            </Link>
          )}
          {run && (
            <Link className="btn btn-out" href="/seller/youtube">
              유튜브 이어 두기
            </Link>
          )}
        </div>
        {run && recent && recent.length > 0 && (
          <table className="tbl" data-testid="oh-recent">
            <thead>
              <tr>
                <th>방송</th>
                <th style={{ width: 120 }}>시작</th>
                <th style={{ width: 90 }}>시간</th>
                <th style={{ width: 90 }}>주문</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((b) => (
                <tr key={b.id}>
                  <td className="col-text">
                    <Link href={`/seller/broadcasts/${b.id}`}>{b.title || "제목 없는 방송"}</Link>
                  </td>
                  <td className="num">{formatDateTime(b.startedAt)}</td>
                  <td className="num">{kstDuration(b.startedAt, b.endedAt)}</td>
                  <td className="num">{b.summary.orders.toLocaleString("ko-KR")}건</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card pad-l" aria-label="쇼핑몰 기능 안내" data-testid="oh-upgrade">
        <h2 className="t-t3">쇼핑몰 기능</h2>
        <p className="t-l2 c-alt">상품·주문·고객·쿠폰은 쇼핑몰까지 쓰는 이용권(통합 구독)에서 쓸 수 있습니다. 지금 쓰는 다른 쇼핑몰은 계속 이어서 쓸 수 있습니다.</p>
        <div>
          <Link className="btn btn-out" href="/seller/subscription">
            이용권 보기
          </Link>
        </div>
      </section>
    </main>
  );
}

function Tile({ label, value, href }: { label: string; value: string; href?: string }) {
  const body = (
    <>
      <span className="t-l2 c-alt">{label}</span>
      <span className="v">{value}</span>
    </>
  );
  return href ? (
    <Link className="stat" href={href}>
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}
