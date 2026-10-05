"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Modal, PageHead } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";

// SA-015 카테고리(파트너스 관리자, 상품 › 카테고리). 대분류 → 하위 2단 트리를 만들고 이름 바꾸기·노출 켜기/끄기·삭제·순서 바꾸기를 한다.
// API: GET/POST /api/seller/categories, PATCH/DELETE /api/seller/categories/[categoryId], PUT /api/seller/categories/order(같은 부모 아래 전부 + 새 순서).
// 순서는 화면에서 위·아래로 옮긴 뒤 「순서 저장」을 눌러야 서버에 반영된다. 대분류를 끄면 하위도 쇼핑몰에서 함께 숨겨진다(서버 규칙).
type Child = { id: string; name: string; visible: boolean; sortOrder: number; productCount: number };
type Node = Child & { children: Child[] };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok" };
type Form = { mode: "add"; parentId: string | null } | { mode: "rename"; id: string; name: string } | null;
const ROOT = "root";
// 서버 lib/server/shop-category/service.ts의 CATEGORY_NAME_MAX·MAX_CATEGORIES와 같은 값(서버 모듈은 prisma를 끌어오므로 화면에서 가져오지 않는다)
const CATEGORY_NAME_MAX = 30;
const MAX_CATEGORIES = 300;

// 서버 순서대로 둔 그룹별 id 목록. 화면에서 바꾼 순서(draft)와 비교해 「바뀜」을 안다.
const groups = (tree: Node[]): Record<string, string[]> => ({ [ROOT]: tree.map((n) => n.id), ...Object.fromEntries(tree.map((n) => [n.id, n.children.map((c) => c.id)])) });
const sameList = (a: string[] | undefined, b: string[] | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

export default function CategoriesPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [tree, setTree] = useState<Node[]>([]);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [form, setForm] = useState<Form>(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string>(ROOT);
  const [remove, setRemove] = useState<{ id: string; name: string; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  // 서버 트리를 받으면 순서 초안(draft)은 그룹의 구성이 그대로인 것만 남긴다
  const apply = useCallback((next: Node[], keepDraft: boolean) => {
    setTree(next);
    setDraft((d) => {
      if (!keepDraft) return groups(next);
      const fresh = groups(next);
      const out: Record<string, string[]> = {};
      for (const [k, ids] of Object.entries(fresh)) {
        const old = d[k];
        out[k] = old && old.length === ids.length && ids.every((i) => old.includes(i)) ? old : ids;
      }
      return out;
    });
  }, []);

  const load = useCallback(async () => {
    const r = await api<{ categories: Node[] }>("/api/seller/categories");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    apply(r.data.categories, false);
    setStale(false);
    setState({ kind: "ok" });
  }, [apply]);
  useEffect(() => {
    void load();
  }, [load]);

  const total = tree.reduce((n, c) => n + 1 + c.children.length, 0);
  const sortBy = <T extends { id: string }>(items: T[], key: string) => {
    const order = draft[key];
    return order ? [...items].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : items;
  };
  const fresh = groups(tree);
  const changed = Object.keys(fresh).filter((k) => !sameList(draft[k], fresh[k]));

  const move = (key: string, id: string, dir: -1 | 1) =>
    setDraft((d) => {
      const list = [...(d[key] ?? fresh[key])];
      const i = list.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return d;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...d, [key]: list };
    });

  const failure = (r: { status: number; message?: string }, fallback: string) => setToast({ text: r.message ?? (r.status === 0 ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오" : fallback), neg: true });

  const saveOrder = async () => {
    setBusy(true);
    let last: Node[] | null = null;
    for (const key of changed) {
      const r = await api<{ categories: Node[] }>("/api/seller/categories/order", { method: "PUT", body: { parentId: key === ROOT ? null : key, categoryIds: draft[key] } });
      if (!r.ok) {
        setBusy(false);
        if (r.error === "invalid_category_order") return setStale(true);
        return failure(r, "순서를 저장하지 못했습니다. 다시 시도해 주십시오");
      }
      last = r.data.categories;
    }
    setBusy(false);
    if (last) apply(last, false);
    setToast({ text: "카테고리 순서를 저장했습니다 · 쇼핑몰에 바로 반영" });
  };

  const toggle = async (id: string, visible: boolean) => {
    const r = await api<{ categories: Node[] }>(`/api/seller/categories/${id}`, { method: "PATCH", body: { visible } });
    if (!r.ok) return failure(r, "노출 설정을 바꾸지 못했습니다. 다시 시도해 주십시오");
    apply(r.data.categories, true);
  };

  const openAdd = (parentId: string | null) => {
    setName("");
    setParent(parentId ?? ROOT);
    setForm({ mode: "add", parentId });
  };
  const submit = async () => {
    if (!form) return;
    setBusy(true);
    const r =
      form.mode === "add"
        ? await api<{ categories: Node[] }>("/api/seller/categories", { method: "POST", body: { name, ...(parent === ROOT ? {} : { parentId: parent }) } })
        : await api<{ categories: Node[] }>(`/api/seller/categories/${form.id}`, { method: "PATCH", body: { name } });
    setBusy(false);
    if (!r.ok) return failure(r, "저장하지 못했습니다. 다시 시도해 주십시오");
    apply(r.data.categories, true);
    setForm(null);
    setToast({ text: form.mode === "add" ? `「${name.trim()}」을 추가했습니다` : "이름을 바꿨습니다" });
  };
  const confirmRemove = async () => {
    if (!remove) return;
    setBusy(true);
    const r = await api<{ categories: Node[] }>(`/api/seller/categories/${remove.id}`, { method: "DELETE" });
    setBusy(false);
    setRemove(null);
    if (!r.ok) return failure(r, "삭제하지 못했습니다. 다시 시도해 주십시오");
    apply(r.data.categories, true);
    setToast({ text: `「${remove.name}」을 삭제했습니다` });
  };

  const nameLen = [...name.trim()].length;
  const nameBad = nameLen === 0 || nameLen > CATEGORY_NAME_MAX;
  const atLimit = total >= MAX_CATEGORIES;
  const parents = sortBy(tree, ROOT);
  const childCount = tree.reduce((n, c) => n + c.children.length, 0);

  const Moves = ({ gKey, id, i, len }: { gKey: string; id: string; i: number; len: number }) => (
    <span className="row" style={{ gap: 2 }}>
      <button className="btn btn-sm btn-out" type="button" aria-label="위로" disabled={i === 0 || busy} onClick={() => move(gKey, id, -1)}>
        ▲
      </button>
      <button className="btn btn-sm btn-out" type="button" aria-label="아래로" disabled={i === len - 1 || busy} onClick={() => move(gKey, id, 1)}>
        ▼
      </button>
    </span>
  );

  return (
    <>
      <Topbar crumb="상품 › 카테고리" />
      <main className="main">
        <PageHead
          title="카테고리"
          actions={
            <>
              <Link className="btn btn-out" href="/seller/products">
                상품 목록
              </Link>
              <button className="btn" type="button" disabled={changed.length === 0 || busy || stale} onClick={() => void saveOrder()}>
                순서 저장
              </button>
            </>
          }
        />

        {stale && (
          <div className="msg msg-neg" role="alert">
            <span>
              <b>순서를 저장하지 못했습니다.</b> 그사이 다른 창에서 카테고리가 추가되거나 삭제되었습니다. 목록을 새로 고친 뒤 다시 바꿔 주십시오.
            </span>
            <button className="btn btn-sm" type="button" onClick={() => void load()}>
              새로 고침
            </button>
          </div>
        )}

        <div className="card" style={{ overflow: "visible" }}>
          <div className="toolbar">
            <span className="t-l2 c-alt" data-testid="category-count">
              {state.kind === "ok" ? `대분류 ${tree.length} · 하위 ${childCount}` : ""}
            </span>
            <span style={{ marginLeft: "auto" }} />
            <button className="btn btn-sm" type="button" disabled={atLimit || state.kind !== "ok"} onClick={() => openAdd(null)}>
              대분류 추가
            </button>
          </div>
          {atLimit && (
            <div className="msg msg-cau" role="status">
              <span>카테고리는 쇼핑몰당 {MAX_CATEGORIES}개까지 만들 수 있습니다. 쓰지 않는 카테고리를 지운 뒤 추가해 주십시오.</span>
            </div>
          )}

          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="상품" /> : state.status === 402 ? <Locked /> : <ErrorState title="카테고리를 불러오지 못했습니다" onRetry={() => void load()} />)}
          {state.kind === "ok" && tree.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">+</div>
              <span className="t">카테고리가 없습니다</span>
              <span className="s">없어도 상품은 「전체」에 보입니다.</span>
              <button className="btn btn-sm" type="button" onClick={() => openAdd(null)}>
                대분류 추가
              </button>
            </div>
          )}
          {state.kind === "ok" && tree.length > 0 && (
            <div className="au-lt-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th style={{ width: 90 }}>상품</th>
                    <th style={{ width: 110 }}>쇼핑몰 노출</th>
                    <th style={{ width: 90 }}>순서</th>
                    <th style={{ width: 260 }} aria-label="관리" />
                  </tr>
                </thead>
                <tbody>
                  {parents.map((p, pi) => {
                    const kids = sortBy(p.children, p.id);
                    return [
                      <tr key={p.id} data-testid="category-row" data-level="1">
                        <td>
                          <b>{p.name}</b> <span className="t-c1 c-alt">대분류 · 하위 {p.children.length}</span>
                          {!p.visible && <span className="bdg b-gray nodot" style={{ marginLeft: 6 }}>숨김</span>}
                        </td>
                        <td className="num">{p.productCount}개</td>
                        <td>
                          <input className="cbx" type="checkbox" aria-label={`${p.name} 쇼핑몰 노출`} checked={p.visible} onChange={(e) => void toggle(p.id, e.target.checked)} />
                        </td>
                        <td>
                          <Moves gKey={ROOT} id={p.id} i={pi} len={parents.length} />
                        </td>
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            <button className="btn btn-sm" type="button" disabled={atLimit} onClick={() => openAdd(p.id)}>
                              하위 추가
                            </button>
                            <button className="btn btn-sm btn-out" type="button" onClick={() => (setName(p.name), setForm({ mode: "rename", id: p.id, name: p.name }))}>
                              이름 바꾸기
                            </button>
                            <button className="btn btn-sm btn-out" type="button" onClick={() => setRemove({ id: p.id, name: p.name, count: p.productCount })}>
                              삭제
                            </button>
                          </div>
                        </td>
                      </tr>,
                      ...kids.map((c, ci) => (
                        <tr key={c.id} data-testid="category-row" data-level="2">
                          <td style={{ paddingLeft: 32 }}>
                            └ {c.name}
                            {!c.visible && <span className="bdg b-gray nodot" style={{ marginLeft: 6 }}>숨김</span>}
                          </td>
                          <td className="num">{c.productCount}개</td>
                          <td>
                            <input className="cbx" type="checkbox" aria-label={`${c.name} 쇼핑몰 노출`} checked={c.visible} onChange={(e) => void toggle(c.id, e.target.checked)} />
                          </td>
                          <td>
                            <Moves gKey={p.id} id={c.id} i={ci} len={kids.length} />
                          </td>
                          <td>
                            <div className="row" style={{ gap: 6 }}>
                              <button className="btn btn-sm btn-out" type="button" onClick={() => (setName(c.name), setForm({ mode: "rename", id: c.id, name: c.name }))}>
                                이름 바꾸기
                              </button>
                              <button className="btn btn-sm btn-out" type="button" onClick={() => setRemove({ id: c.id, name: c.name, count: c.productCount })}>
                                삭제
                              </button>
                            </div>
                          </td>
                        </tr>
                      )),
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {state.kind === "ok" && tree.length > 0 && (
          <span className="t-c1 c-alt">대분류는 쇼핑몰 상단 메뉴, 하위는 그 아래 목록 · 칩이 됩니다 · 대분류를 끄면 그 아래 하위도 쇼핑몰에서 함께 사라집니다 · 순서는 같은 대분류 안에서만 바꿀 수 있고 바꾼 뒤 「순서 저장」을 누릅니다 · 상품은 대분류와 하위 어느 쪽이든 고를 수 있습니다.</span>
        )}

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
                      {sortBy(p.children, p.id)
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
      </main>

      {form && (
        <Modal labelId="cat-form-title" busy={busy} dirty={form.mode === "rename" ? name !== form.name : name !== ""} onClose={() => setForm(null)}>
          <div className="modal-h">
            <h2 className="modal-t" id="cat-form-title">
              {form.mode === "add" ? (form.parentId ? "하위 카테고리 추가" : "대분류 추가") : "이름 바꾸기"}
            </h2>
          </div>
          <div className="col" style={{ gap: 12, padding: "0 20px 16px" }}>
            {form.mode === "add" && (
              <label className="col" style={{ gap: 4 }}>
                <span className="t-l2">상위 대분류</span>
                <select className="inp" value={parent} onChange={(e) => setParent(e.target.value)}>
                  <option value={ROOT}>(대분류로 추가)</option>
                  {tree.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="col" style={{ gap: 4 }}>
              <span className="t-l2">이름</span>
              <input className="inp" type="text" value={name} maxLength={CATEGORY_NAME_MAX + 10} aria-invalid={nameLen > CATEGORY_NAME_MAX} onChange={(e) => setName(e.target.value)} />
              <span className={nameLen > CATEGORY_NAME_MAX ? "t-c1 c-neg" : "t-c1 c-alt"}>
                {nameLen > CATEGORY_NAME_MAX ? "이름은 30자까지 입력할 수 있습니다" : `${nameLen} / ${CATEGORY_NAME_MAX}`}
              </span>
            </label>
            {form.mode === "rename" && <span className="t-c1 c-alt">연결된 상품 표기와 쇼핑몰 메뉴 · 칩 이름이 함께 바뀝니다.</span>}
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={() => setForm(null)} disabled={busy}>
              취소
            </button>
            <button className="btn" type="button" disabled={nameBad || busy} onClick={() => void submit()}>
              {busy ? "저장 중" : form.mode === "add" ? "추가" : "저장"}
            </button>
          </div>
        </Modal>
      )}
      {remove && (
        <Modal labelId="cat-del-title" busy={busy} onClose={() => setRemove(null)}>
          <div className="modal-h">
            <h2 className="modal-t" id="cat-del-title">
              「{remove.name}」을 삭제하시겠습니까?
            </h2>
            <span className="t-l2 c-alt">상품 {remove.count}개는 지워지지 않고 이 카테고리 연결만 풀립니다. 쇼핑몰에서는 바로 사라집니다.</span>
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={() => setRemove(null)} disabled={busy}>
              취소
            </button>
            <button className="btn btn-neg" type="button" onClick={() => void confirmRemove()} disabled={busy}>
              {busy ? "삭제 중" : "삭제"}
            </button>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
