"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FormRow, FormSection, ListTable, Modal, PageHead } from "../admin-ui";
import { Topbar, useSeller } from "./SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "./States";
import { api } from "./api";
import { confirmLeave, sanitizeNext, useSmartBack, useUnsavedGuard } from "../../lib/client/navigation";

type Child = { id: string; name: string; visible: boolean; sortOrder: number; productCount: number };
export type CategoryNode = Child & { children: Child[] };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok" };
type Form = { mode: "add"; parentId: string | null } | { mode: "rename"; id: string; name: string } | null;
const ROOT = "root";
// 서버 lib/server/shop-category/service.ts의 CATEGORY_NAME_MAX·MAX_CATEGORIES와 같은 값(서버 모듈은 prisma를 끌어오므로 화면에서 가져오지 않는다)
const CATEGORY_NAME_MAX = 30;
const MAX_CATEGORIES = 300;

// 서버 순서대로 둔 그룹별 id 목록. 화면에서 바꾼 순서(draft)와 비교해 「바뀜」을 안다.
const groups = (tree: CategoryNode[]): Record<string, string[]> => ({ [ROOT]: tree.map((n) => n.id), ...Object.fromEntries(tree.map((n) => [n.id, n.children.map((c) => c.id)])) });
const sameList = (a: string[] | undefined, b: string[] | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

export function CategoryOperations({ categoryId, parentId, order = false, returnTo }: { categoryId?: string; parentId?: string | null; order?: boolean; returnTo?: string | null }) {
  const { can, me } = useSeller();
  const allowed = can("PRODUCT_MANAGE") && !me.readOnly;
  const generation = useRef(0);
  const initialized = useRef(false);
  const [completed, setCompleted] = useState(false);
  const safeReturnTo = sanitizeNext(returnTo, ["/seller/products/categories"]);
  const listHref = safeReturnTo?.split("?")[0] === "/seller/products/categories" ? safeReturnTo : "/seller/products/categories";
  const back = useSmartBack(listHref);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [tree, setTree] = useState<CategoryNode[]>([]);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [form, setForm] = useState<Form>(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string>(ROOT);
  const [remove, setRemove] = useState<{ id: string; name: string; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  // 서버 트리를 받으면 순서 초안(draft)은 그룹의 구성이 그대로인 것만 남긴다
  const apply = useCallback((next: CategoryNode[], keepDraft: boolean) => {
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
    const request = ++generation.current;
    if (!allowed) return;
    setState({ kind: "loading" });
    const r = await api<{ categories: CategoryNode[] }>("/api/seller/categories");
    if (request !== generation.current) return;
    if (!r.ok) return setState({ kind: "error", status: r.status });
    apply(r.data.categories, false);
    setStale(false);
    setState({ kind: "ok" });
  }, [apply, allowed]);
  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, [load]);

  const total = tree.reduce((n, c) => n + 1 + c.children.length, 0);
  const sortBy = <T extends { id: string }>(items: T[], key: string) => {
    const order = draft[key];
    return order ? [...items].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : items;
  };
  const fresh = groups(tree);
  const changed = Object.keys(fresh).filter((k) => !sameList(draft[k], fresh[k]));
  const item = categoryId ? tree.flatMap((node) => [node, ...node.children]).find((node) => node.id.toLowerCase() === categoryId.toLowerCase()) : undefined;
  const validParent = !parentId || tree.some((node) => node.id === parentId);
  const dirty = order ? changed.length > 0 : form ? form.mode === "rename" ? name !== form.name : name !== "" || parent !== (parentId ?? ROOT) : false;
  const releaseGuard = useUnsavedGuard(dirty);
  const cancel = async () => { if (busy || !confirmLeave(dirty)) return; await releaseGuard(); back(); };
  const refresh = async () => { if (!confirmLeave(dirty)) return; await releaseGuard(); initialized.current = false; setForm(null); await load(); };
  useEffect(() => {
    if (order || state.kind !== "ok" || initialized.current || !validParent || (categoryId && !item)) return;
    initialized.current = true;
    setName(item?.name ?? "");
    setParent(parentId ?? ROOT);
    setForm(item ? { mode: "rename", id: item.id, name: item.name } : { mode: "add", parentId: parentId ?? null });
  }, [order, state.kind, validParent, categoryId, item, parentId]);


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
    let last: CategoryNode[] | null = null;
    for (const key of changed) {
      const r = await api<{ categories: CategoryNode[] }>("/api/seller/categories/order", { method: "PUT", body: { parentId: key === ROOT ? null : key, categoryIds: draft[key] } });
      if (!r.ok) {
        setBusy(false);
        if (r.error === "invalid_category_order") return setStale(true);
        return failure(r, "순서를 저장하지 못했습니다. 다시 시도해 주십시오");
      }
      last = r.data.categories;
    }
    await releaseGuard();
    if (last) apply(last, false);
    setBusy(false);
    setToast({ text: "카테고리 순서를 저장했습니다 · 쇼핑몰에 바로 반영" });
  };

  const toggle = async (id: string, visible: boolean) => {
    const r = await api<{ categories: CategoryNode[] }>(`/api/seller/categories/${id}`, { method: "PATCH", body: { visible } });
    if (!r.ok) return failure(r, "노출 설정을 바꾸지 못했습니다. 다시 시도해 주십시오");
    apply(r.data.categories, true);
  };

  const submit = async () => {
    if (!form) return;
    setBusy(true);
    const r =
      form.mode === "add"
        ? await api<{ categories: CategoryNode[] }>("/api/seller/categories", { method: "POST", body: { name, ...(parent === ROOT ? {} : { parentId: parent }) } })
        : await api<{ categories: CategoryNode[] }>(`/api/seller/categories/${form.id}`, { method: "PATCH", body: { name } });
    if (!r.ok) { setBusy(false); return failure(r, "저장하지 못했습니다. 다시 시도해 주십시오"); }
    await releaseGuard();
    apply(r.data.categories, true);
    setName(name.trim());
    setForm(form.mode === "rename" ? { ...form, name: name.trim() } : null);
    if (form.mode === "add") setCompleted(true);
    setBusy(false);
    setToast({ text: form.mode === "add" ? `「${name.trim()}」을 추가했습니다` : "이름을 바꿨습니다" });
  };
  const confirmRemove = async () => {
    if (!remove) return;
    setBusy(true);
    const r = await api<{ categories: CategoryNode[] }>(`/api/seller/categories/${remove.id}`, { method: "DELETE" });
    if (!r.ok) { setBusy(false); setRemove(null); return failure(r, "삭제하지 못했습니다. 다시 시도해 주십시오"); }
    await releaseGuard();
    setBusy(false);
    setRemove(null);
    setCompleted(true);
    setForm(null);
    apply(r.data.categories, true);
    setToast({ text: `「${remove.name}」을 삭제했습니다` });
  };

  const nameLen = [...name.trim()].length;
  const nameBad = nameLen === 0 || nameLen > CATEGORY_NAME_MAX;
  const atLimit = total >= MAX_CATEGORIES;
  const parents = sortBy(tree, ROOT);

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

  return <><Topbar crumb="상품 › 카테고리 › 상세" /><main className="main">
    <PageHead title={order ? "카테고리 순서 설정" : categoryId ? "카테고리 상세" : parentId ? "하위 카테고리 추가" : "대분류 추가"} back={listHref} onBack={cancel} />
    {!allowed ? <NoPermission need="상품" /> : state.kind === "loading" ? <div className="card"><LoadingRows rows={5} /></div> : state.kind === "error" ? state.status === 403 ? <NoPermission need="상품" /> : state.status === 402 ? <div className="card"><Locked /></div> : <div className="card"><ErrorState title="카테고리를 불러오지 못했습니다" onRetry={() => void refresh()} /></div> : completed ? <section className="card pad"><p role="status">카테고리 처리를 마쳤습니다</p><button className="btn btn-out" type="button" onClick={back}>목록으로</button></section> : order ? <section aria-label="카테고리 순서 설정">
      {stale && <div className="msg msg-neg" role="alert"><span><b>순서를 저장하지 못했습니다.</b> 그사이 다른 창에서 카테고리가 추가되거나 삭제되었습니다. 목록을 새로 고친 뒤 다시 바꿔 주십시오.</span><button className="btn btn-sm" type="button" onClick={() => void refresh()}>새로 고침</button></div>}
      <p className="help">순서는 같은 대분류 안에서만 바꿀 수 있고 바꾼 뒤 「순서 저장」을 누릅니다.</p>
      <ListTable><table className="tbl"><thead><tr><th>이름</th><th>상품</th><th>쇼핑몰 노출</th><th>순서</th></tr></thead><tbody>{parents.flatMap((node, index) => [
        <tr key={node.id} data-testid="category-row" data-level="1"><td><b>{node.name}</b></td><td>{node.productCount}개</td><td>{node.visible ? "보임" : "숨김"}</td><td><Moves gKey={ROOT} id={node.id} i={index} len={parents.length} /></td></tr>,
        ...sortBy(node.children, node.id).map((child, index, all) => <tr key={child.id} data-testid="category-row" data-level="2"><td>└ {child.name}</td><td>{child.productCount}개</td><td>{child.visible ? "보임" : "숨김"}</td><td><Moves gKey={node.id} id={child.id} i={index} len={all.length} /></td></tr>),
      ])}</tbody></table></ListTable>
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

      <div className="row" style={{ gap: 8, marginTop: 16 }}><button className="btn" type="button" disabled={changed.length === 0 || busy || stale} onClick={() => void saveOrder()}>순서 저장</button><button className="btn btn-out" type="button" disabled={busy} onClick={() => void cancel()}>취소</button></div>
    </section> : !validParent || (categoryId && !item) ? <div className="card"><ErrorState title="카테고리를 찾을 수 없습니다" onRetry={() => void refresh()} /></div> : form && <section aria-label={form.mode === "rename" ? "카테고리 변경" : form.parentId ? "하위 카테고리 추가" : "대분류 추가"}>
      <FormSection title={form.mode === "rename" ? "이름 바꾸기" : form.parentId ? "하위 카테고리 추가" : "대분류 추가"}>
          <FormRow label="카테고리 정보"><div className="col" style={{ gap: 12 }}>
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
          </div></FormRow>
          <FormRow label="작업"><div className="row" style={{ gap: 8 }}>
            <button className="btn btn-out" type="button" onClick={() => void cancel()} disabled={busy}>
              취소
            </button>
            <button className="btn" type="button" disabled={nameBad || busy || (form.mode === "add" && atLimit)} onClick={() => void submit()}>
              {busy ? "저장 중" : form.mode === "add" ? "추가" : "저장"}
            </button>
          </div></FormRow>

      </FormSection>
      {item && <FormSection title="노출 · 삭제"><FormRow label="쇼핑몰 노출"><label className="chk"><input className="cbx" type="checkbox" aria-label={`${item.name} 쇼핑몰 노출`} checked={item.visible} onChange={(e) => void toggle(item.id, e.target.checked)} />쇼핑몰 노출</label></FormRow><FormRow label="삭제"><button className="btn btn-neg" type="button" onClick={() => setRemove({ id: item.id, name: item.name, count: item.productCount })}>삭제</button></FormRow></FormSection>}
      {atLimit && form.mode === "add" && <p role="status">카테고리는 쇼핑몰당 {MAX_CATEGORIES}개까지 만들 수 있습니다. 쓰지 않는 카테고리를 지운 뒤 추가해 주십시오.</p>}
    </section>}
  </main>
      {allowed && state.kind === "ok" && remove && (
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
  </>;
}
