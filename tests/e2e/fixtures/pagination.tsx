import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Pagination, CursorPagination } from "../../../components/Pagination";

function Fixture() {
  const params = new URLSearchParams(location.search);
  const [page, setPage] = useState(Number(params.get("page") ?? 1));
  const [visited, setVisited] = useState(1);
  const [cursorPage, setCursorPage] = useState(1);
  const count = Number(params.get("count") ?? 23);
  return <main className={`app ${params.has("shop") ? "shop-app" : "c24 seller-app"}`} style={{ padding: 24 }}>
    <section aria-label="전체 건수"><Pagination page={page} pageCount={count} onChange={setPage} /></section>
    <section aria-label="쇼핑몰 링크"><Pagination page={page} pageCount={count} href={n => { const q = new URLSearchParams(location.search); q.set("page", String(n)); q.set("q", "보존"); return `/?${q}`; }} /></section>
    <section aria-label="방문 커서"><CursorPagination page={cursorPage} visited={visited} hasNext={cursorPage < 3} onChange={setCursorPage} onNext={() => { setVisited(n => n + 1); setCursorPage(n => n + 1); }} /></section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
