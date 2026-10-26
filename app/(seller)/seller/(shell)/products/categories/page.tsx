"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ListTable, PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import type { CategoryNode } from "../../../../../../components/seller/CategoryOperations";

export default function CategoriesPage() {
  const { can, me } = useSeller();
  const canManage = can("PRODUCT_MANAGE") && !me.readOnly;
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok" }>({ kind: "loading" });
  const [tree, setTree] = useState<CategoryNode[]>([]);
  const generation = useRef(0);
  const query = useSearchParams(), pathname = usePathname();
  const listHref = `${pathname}${query.size ? `?${query.toString()}` : ""}`;
  const href = (segment: string, parentId?: string) => `/seller/products/categories/${segment}?${new URLSearchParams({ returnTo: listHref, ...(parentId ? { parentId } : {}) })}`;
  const load = useCallback(async () => {
    const request = ++generation.current;
    setState({ kind: "loading" });
    const r = await api<{ categories: CategoryNode[] }>("/api/seller/categories");
    if (request !== generation.current) return;
    if (!r.ok) { setTree([]); return setState({ kind: "error", status: r.status }); }
    setTree(r.data.categories); setState({ kind: "ok" });
  }, []);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const total = tree.reduce((n, node) => n + 1 + node.children.length, 0), childCount = tree.reduce((n, node) => n + node.children.length, 0), atLimit = total >= 300;
  const parents = tree;
  const tableRow = (node: CategoryNode | CategoryNode["children"][number], level: 1 | 2) => <tr key={node.id} data-testid="category-row" data-level={level}>
    <td className="col-text" style={level === 2 ? { paddingLeft: 32 } : undefined}>{level === 2 ? "└ " : ""}<b>{node.name}</b>{level === 1 && "children" in node && <span className="t-c1 c-alt"> 대분류 · 하위 {node.children.length}</span>}{!node.visible && <span className="bdg b-gray nodot" style={{ marginLeft: 6 }}>숨김</span>}</td>
    <td className="num">{node.productCount}개</td><td>{node.visible ? "보임" : "숨김"}</td><td>{node.sortOrder + 1}</td>
    <td><div className="row" style={{ gap: 6 }}><Link className="btn btn-sm btn-out" href={href(node.id)}>상세</Link>{canManage && level === 1 && !atLimit && <Link className="btn btn-sm" href={href("new", node.id)}>하위 추가</Link>}</div></td>
  </tr>;
  return <><Topbar crumb="상품 › 카테고리" /><main className="main">
    <PageHead title="카테고리" actions={<><Link className="btn btn-out" href="/seller/products">상품 목록</Link>{canManage && <Link className="btn" href={href("order")}>순서 설정</Link>}</>} />
    <section className="au-list-section">
      <div className="toolbar"><span className="t-l2 c-alt" data-testid="category-count">{state.kind === "ok" ? `대분류 ${tree.length} · 하위 ${childCount}` : ""}</span><span style={{ marginLeft: "auto" }} />{canManage && !atLimit && state.kind === "ok" && <Link className="btn btn-sm" href={href("new")}>대분류 추가</Link>}</div>
      {atLimit && <div className="msg msg-cau" role="status"><span>카테고리는 쇼핑몰당 300개까지 만들 수 있습니다. 쓰지 않는 카테고리를 지운 뒤 추가해 주십시오.</span></div>}
      {state.kind === "loading" && <div className="card"><LoadingRows rows={5} /></div>}
      {state.kind === "error" && (state.status === 403 ? <NoPermission need="상품" /> : state.status === 402 ? <div className="card"><Locked /></div> : <div className="card"><ErrorState title="카테고리를 불러오지 못했습니다" onRetry={() => void load()} /></div>)}
      {state.kind === "ok" && tree.length === 0 && <div className="card"><div className="st" style={{ boxShadow: "none" }}><div className="st-ic">+</div><span className="t">카테고리가 없습니다</span><span className="s">없어도 상품은 「전체」에 보입니다.</span>{canManage && <Link className="btn btn-sm" href={href("new")}>대분류 추가</Link>}</div></div>}
      {state.kind === "ok" && tree.length > 0 && <ListTable><table className="tbl"><thead><tr><th>이름</th><th style={{ width: 90 }}>상품</th><th style={{ width: 110 }}>쇼핑몰 노출</th><th style={{ width: 90 }}>순서</th><th style={{ width: 260 }} aria-label="관리" /></tr></thead><tbody>{tree.flatMap((node) => [tableRow(node, 1), ...node.children.map((child) => tableRow(child, 2))])}</tbody></table></ListTable>}
    </section>
    {state.kind === "ok" && tree.length > 0 && <span className="t-c1 c-alt">대분류는 쇼핑몰 상단 메뉴, 하위는 그 아래 목록 · 칩이 됩니다 · 대분류를 끄면 그 아래 하위도 쇼핑몰에서 함께 사라집니다 · 순서는 같은 대분류 안에서만 바꿀 수 있고 바꾼 뒤 「순서 저장」을 누릅니다 · 상품은 대분류와 하위 어느 쪽이든 고를 수 있습니다.</span>}
        {state.kind === "ok" && tree.some((p) => p.visible) && (
          <section className="card" style={{ padding: 16 }} aria-label="쇼핑몰 미리보기">
            <h2 className="t-h2">쇼핑몰에 이렇게 보입니다</h2>
            <div className="row" style={{ gap: 12, flexWrap: "wrap", margin: "8px 0" }} data-testid="category-preview">
              {parents
                .filter((p) => p.visible)
                .map((p) => (
                  <div key={p.id} className="col" style={{ gap: 4 }}>
                    <b>{p.name}</b>
                    <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                      <span className="chip on">전체</span>
                      {p.children
                        .filter((c) => c.visible)
                        .map((c) => (
                          <span key={c.id} className="chip">
                            {c.name}
                          </span>
                        ))}
                    </span>
                  </div>
                ))}
            </div>
            <span className="t-c1 c-alt">위는 대분류 메뉴, 아래는 대분류별 하위 칩입니다 · 꺼 둔 항목은 보이지 않습니다.</span>
          </section>
        )}
  </main></>;
}
