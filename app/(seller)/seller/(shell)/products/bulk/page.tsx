"use client";

import "../../../../../../styles/seller-orders.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { useUrlState } from "../../../../../../lib/client/navigation";
import { kstText } from "../../banners/_shared/ui";

// SA-018 엑셀 일괄 등록 · 내보내기(파트너스 관리자, 상품 › 엑셀로 올리기 · 내려받기). 정본 design/project/SA-018.dc.html: 파일 올리기 → 올린 파일 확인(미리보기) → 반영, 내보내기, 양식 안내, 처리 이력(되돌리기).
// API: GET /api/seller/bulk-io/products/template(양식 CSV), POST /api/seller/bulk-io/products/preview({ csv, fileName }), POST /api/seller/bulk-io/jobs/[id]/commit, POST .../undo(24시간 안), GET /api/seller/bulk-io/jobs(최근 30개), GET /api/seller/bulk-io/products/export(CSV). 모두 상품 관리(PRODUCT_MANAGE) 권한.
// 서버는 CSV 한 가지 형식(1,000행 · 1MB)이다. 서버 모듈은 prisma를 끌어오므로 한도 값은 같게 적는다.
type Preview = {
  jobId: string;
  totalRows: number;
  productCount: number;
  skippedProductCount: number;
  errorTotal: number;
  errors: { row: number; column: string | null; message: string }[];
  products: { row: number; name: string; price: number; status: string; optionCount: number; categories: string[] }[];
};
type Job = {
  id: string;
  status: "PREVIEW" | "COMMITTING" | "COMMITTED" | "UNDONE";
  fileName: string | null;
  totalRows: number;
  productCount: number;
  createdCount: number;
  failedCount: number;
  errorTotal: number;
  keptCount: number;
  createdAt: string;
  committedAt: string | null;
  undoUntil: string | null;
  undoable: boolean;
};
type Jobs = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; jobs: Job[] };

const MAX_BYTES = 1_000_000;
const STATUS: Record<string, string> = { ON_SALE: "판매중", SOLD_OUT: "품절", DRAFT: "준비중", HIDDEN: "숨김" };
const JOB_BADGE: Record<Job["status"], { label: string; cls: string }> = {
  PREVIEW: { label: "미리보기만", cls: "b-gray nodot" },
  COMMITTING: { label: "반영 중", cls: "b-wait" },
  COMMITTED: { label: "반영 완료", cls: "b-done" },
  UNDONE: { label: "되돌림", cls: "b-gray nodot" },
};

// 오류 행만 내려받기(엑셀에서 열면 한글이 깨지지 않게 BOM을 붙인다)
function errorsCsv(errors: Preview["errors"]): string {
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  return "﻿" + [["행", "열", "오류"], ...errors.map((e) => [e.row, e.column ?? "", e.message])].map((r) => r.map(q).join(",")).join("\r\n");
}

export default function BulkPage() {
  const { can } = useSeller();
  const { confirm } = useConfirm();
  const canEdit = can("PRODUCT_MANAGE");
  const input = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Jobs>({ kind: "loading" });
  const [preview, setPreview] = useState<{ fileName: string; data: Preview } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [over, setOver] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const [query] = useUrlState({ section: "register" });
  const section = ["register", "export", "history"].includes(query.section) ? query.section : "register";
  useEffect(() => {
    if (section !== "register") document.getElementById(`bulk-${section}`)?.scrollIntoView({ block: "start" });
  }, [section]);

  const loadJobs = useCallback(async () => {
    const r = await api<{ jobs: Job[] }>("/api/seller/bulk-io/jobs");
    setJobs(r.ok ? { kind: "ok", jobs: r.data.jobs } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const upload = async (file: File | undefined) => {
    if (!file || uploading) return;
    if (input.current) input.current.value = "";
    setFailure(null);
    if (file.size > MAX_BYTES) return setFailure(`1MB를 넘었습니다 · 지금 파일: ${(file.size / 1024 / 1024).toFixed(1)}MB. 나누어 올려 주십시오`);
    setUploading(true);
    const csv = await file.text();
    const r = await api<Preview>("/api/seller/bulk-io/products/preview", { method: "POST", body: { csv, fileName: file.name } });
    setUploading(false);
    if (!r.ok) return setFailure(r.message ?? "파일을 확인하지 못했습니다. 양식 그대로 CSV로 저장해 올려 주십시오");
    setPreview({ fileName: file.name, data: r.data });
    void loadJobs();
  };

  const commit = async () => {
    if (!preview) return;
    const { data } = preview;
    await confirm({
      title: `${data.productCount}개 상품을 등록하시겠습니까?`,
      body: `새 상품으로 등록합니다.${data.errorTotal > 0 ? ` 오류 ${data.errorTotal}건은 건너뜁니다.` : ""} 등록한 상품은 24시간 안에 처리 이력에서 되돌릴 수 있습니다.`,
      confirmLabel: "등록",
      run: async () => {
        const r = await api<{ createdCount: number; failedCount: number }>(`/api/seller/bulk-io/jobs/${data.jobId}/commit`, { method: "POST" });
        if (!r.ok) return r.message ?? "등록하지 못했습니다. 잠시 뒤 다시 시도해 주십시오";
        setPreview(null);
        setToast({ text: `${r.data.createdCount}개 등록했습니다${r.data.failedCount > 0 ? ` · ${r.data.failedCount}개는 등록하지 못했습니다` : ""}` });
        await loadJobs();
      },
    });
  };

  const undo = async (j: Job) => {
    await confirm({
      title: "이 등록을 되돌리시겠습니까?",
      body: `${kstText(j.committedAt ?? j.createdAt)} 「${j.fileName ?? "일괄 등록"} · 상품 ${j.createdCount}개」로 등록한 상품을 삭제합니다. 이미 주문이 있는 상품은 그대로 둡니다.`,
      confirmLabel: "되돌리기",
      danger: true,
      run: async () => {
        const r = await api<{ removedCount: number; keptCount: number }>(`/api/seller/bulk-io/jobs/${j.id}/undo`, { method: "POST" });
        if (!r.ok) return r.message ?? "되돌리지 못했습니다. 잠시 뒤 다시 시도해 주십시오";
        setToast({ text: `${r.data.removedCount}개를 되돌렸습니다${r.data.keptCount > 0 ? ` · 주문이 있는 ${r.data.keptCount}개는 남겼습니다` : ""}` });
        await loadJobs();
      },
    });
  };

  const downloadErrors = () => {
    if (!preview) return;
    const url = URL.createObjectURL(new Blob([errorsCsv(preview.data.errors)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "오류_행.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Topbar crumb="상품 › 엑셀로 올리기 · 내려받기" />
      <main className="main">
        <PageHead
          title="엑셀 일괄 등록 · 내보내기"
          actions={
            canEdit ? (
              <>
                <a className="btn btn-out" href="/api/seller/bulk-io/products/template" download>
                  양식 내려받기
                </a>
                <button className="btn" type="button" disabled={uploading} onClick={() => input.current?.click()}>
                  {uploading ? "확인 중" : "파일 올리기"}
                </button>
              </>
            ) : undefined
          }
        />
        <input ref={input} type="file" accept=".csv,text/csv" hidden aria-label="CSV 파일 선택" onChange={(e) => void upload(e.target.files?.[0])} />
        {!canEdit && (
          <div className="msg msg-info" role="status">
            <span>처리 이력만 볼 수 있습니다. 일괄 등록과 내려받기는 「상품 관리」 권한이 있는 계정만 할 수 있습니다.</span>
          </div>
        )}
        {failure && (
          <div className="msg msg-neg" role="alert">
            <span>{failure}</span>
            <a className="btn btn-sm" href="/api/seller/bulk-io/products/template" download>
              양식 내려받기
            </a>
          </div>
        )}

        <div id="bulk-register" />
        {canEdit && !preview && (
          <div
            className="card"
            data-testid="bulk-drop"
            style={{ padding: 28, textAlign: "center", borderStyle: "dashed", background: over ? "var(--wds-fill-alternative)" : undefined }}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void upload(e.dataTransfer.files[0]);
            }}
          >
            <div className="st-ic">+</div>
            <div className="t-l1 fw6">CSV 파일을 끌어다 놓거나 선택해 주십시오</div>
            <div className="t-c1 c-alt">양식 그대로 · 1,000행 · 1MB 이하 · 엑셀에서는 「CSV UTF-8」로 저장합니다</div>
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-out" type="button" disabled={uploading} onClick={() => input.current?.click()}>
                {uploading ? "확인 중" : "파일 선택"}
              </button>
            </div>
          </div>
        )}

        {preview && (
          <section aria-label="올린 파일 확인" data-testid="bulk-preview">
            <div className="sc-sec-t">
              올린 파일 확인 · {preview.fileName}
              {preview.data.errorTotal > 0 && <span className="bdg b-fail" style={{ marginLeft: 8 }}>{preview.data.totalRows}행 중 오류 {preview.data.errorTotal}</span>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 12, margin: "8px 0 12px" }}>
              {(
                [
                  ["새로 등록", `${preview.data.productCount}개`],
                  ["건너뜀 (오류 상품)", `${preview.data.skippedProductCount}개`],
                  ["오류", `${preview.data.errorTotal}건`],
                  ["전체 행", `${preview.data.totalRows}행`],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <div className="t-c1 c-alt">{k}</div>
                  <div className="t-hl2 num">{v}</div>
                </div>
              ))}
            </div>
            {preview.data.products.length > 0 && (
              <div className="au-lt-wrap">
                <table className="tbl" data-testid="bulk-products">
                  <thead>
                    <tr>
                      <th style={{ width: 60 }}>행</th>
                      <th className="col-text" style={{ textAlign: "left" }}>
                        상품명
                      </th>
                      <th>카테고리</th>
                      <th style={{ width: 110, textAlign: "right" }}>판매가</th>
                      <th style={{ width: 80 }}>상태</th>
                      <th style={{ width: 70 }}>옵션</th>
                      <th style={{ width: 110 }}>결과</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.products.map((p) => (
                      <tr key={`${p.row}-${p.name}`}>
                        <td className="num">{p.row}</td>
                        <td className="col-text">{p.name}</td>
                        <td>{p.categories.length > 0 ? p.categories.join(" · ") : "—"}</td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {won(p.price)}
                        </td>
                        <td>{STATUS[p.status] ?? p.status}</td>
                        <td className="num">{p.optionCount}</td>
                        <td>
                          <span className="bdg b-done">등록 가능</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.data.errors.length > 0 && (
              <div className="au-lt-wrap">
                <table className="tbl" data-testid="bulk-errors">
                  <thead>
                    <tr>
                      <th style={{ width: 60 }}>행</th>
                      <th style={{ width: 120 }}>열</th>
                      <th className="col-text" style={{ textAlign: "left" }}>
                        오류
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.errors.map((e, i) => (
                      <tr key={`${e.row}-${i}`}>
                        <td className="num">{e.row}</td>
                        <td>{e.column ?? "—"}</td>
                        <td className="col-text">
                          <span className="bdg b-fail">{e.message}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <span className="t-c1 c-alt">오류가 있는 상품은 건너뛰고 나머지만 반영합니다 · 목록에는 앞부분만 보입니다 · 새 상품은 상태 칸이 비면 「준비중」으로 등록됩니다(이미지를 올린 뒤 공개)</span>
            <div className="row" style={{ gap: 8, margin: "8px 0 4px", flexWrap: "wrap" }}>
              <button className="btn" type="button" disabled={preview.data.productCount === 0} onClick={() => void commit()}>
                {preview.data.productCount}개 반영
              </button>
              {preview.data.errors.length > 0 && (
                <button className="btn btn-out" type="button" onClick={downloadErrors}>
                  오류 행만 내려받기
                </button>
              )}
              <button className="btn btn-out" type="button" onClick={() => setPreview(null)}>
                다른 파일 올리기
              </button>
            </div>
          </section>
        )}

        <div className="sc-sec-t" id="bulk-export">
          내보내기
        </div>
        <div className="au-lt-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 200 }}>항목</th>
                <th className="col-text" style={{ textAlign: "left" }}>
                  포함 내용
                </th>
                <th style={{ width: 200 }}>관리</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <b>상품 · 재고</b>
                </td>
                <td className="col-text">상품명 · 판매가 · 상태 · 설명 · 차감시점 · 카테고리 · 옵션 · 재고 · SKU (양식과 같은 열이라 고쳐서 다시 올릴 수 있습니다 · 개인정보 없음)</td>
                <td>
                  {canEdit ? (
                    <a className="btn" href="/api/seller/bulk-io/products/export" download>
                      내려받기
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
              <tr>
                <td>
                  <b>배송 라벨용 (택배사 양식)</b>
                </td>
                <td className="col-text">배송 준비 주문 · 받는 분 · 주소 · 연락처</td>
                <td>
                  <Link className="btn" href="/seller/shipping">
                    배송 화면에서
                  </Link>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="sc-two">
          <div>
            <div className="sc-sec-t">양식 안내</div>
            <table className="au-ft">
              <tbody>
                <tr>
                  <th>필수 열</th>
                  <td>상품명 · 판매가</td>
                </tr>
                <tr>
                  <th>선택 열</th>
                  <td>상태 · 설명 · 차감시점 · 카테고리 · 옵션명 · 옵션추가금 · 재고 · SKU</td>
                </tr>
                <tr>
                  <th>이미지</th>
                  <td>파일에 넣지 않음 · 등록 뒤 상품 수정에서 업로드</td>
                </tr>
                <tr>
                  <th>한도</th>
                  <td>한 번에 1,000행 · 1MB</td>
                </tr>
                <tr>
                  <th>옵션</th>
                  <td>같은 상품은 이어지는 줄에 옵션명만 적어 늘립니다</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <div className="sc-sec-t" id="bulk-history">
              처리 이력
            </div>
            {jobs.kind === "loading" && <LoadingRows rows={3} />}
            {jobs.kind === "error" &&
              (jobs.status === 403 ? <NoPermission need="상품 관리" /> : jobs.status === 402 ? <Locked /> : <ErrorState title="처리 이력을 불러오지 못했습니다" onRetry={() => void loadJobs()} />)}
            {jobs.kind === "ok" && jobs.jobs.length === 0 && <span className="t-c1 c-alt">아직 처리한 일괄 등록이 없습니다</span>}
            {jobs.kind === "ok" && jobs.jobs.length > 0 && (
              <div className="au-lt-wrap">
                <table className="tbl" data-testid="bulk-jobs">
                  <thead>
                    <tr>
                      <th className="col-text" style={{ textAlign: "left" }}>
                        내용
                      </th>
                      <th style={{ width: 150 }}>언제</th>
                      <th style={{ width: 170 }}>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.jobs.map((j) => (
                      <tr key={j.id} data-testid="bulk-job-row">
                        <td className="col-text">
                          상품 일괄 등록 · {j.fileName ?? "파일 이름 없음"}
                          <div className="t-c1 c-alt">{j.status === "COMMITTED" || j.status === "UNDONE" ? `${j.createdCount}개 등록${j.failedCount + j.errorTotal > 0 ? ` · 오류 ${j.errorTotal}건` : ""}` : `${j.productCount}개 확인`}</div>
                        </td>
                        <td className="num">{kstText(j.committedAt ?? j.createdAt)}</td>
                        <td>
                          <span className={`bdg ${JOB_BADGE[j.status].cls}`}>{JOB_BADGE[j.status].label}</span>
                          {canEdit && j.undoable && (
                            <button className="btn btn-sm btn-out" type="button" style={{ marginLeft: 8 }} onClick={() => void undo(j)}>
                              되돌리기
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <table className="au-ft">
              <tbody>
                <tr>
                  <th>반영 전 확인</th>
                  <td>항상 미리보기 뒤 반영 · 되돌리기는 처리 이력에서 24시간 안</td>
                </tr>
                <tr>
                  <th>권한</th>
                  <td>상품 관리 권한</td>
                </tr>
                <tr>
                  <th>기록</th>
                  <td>모든 반영 · 내보내기는 로그 추적에 남습니다</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
