"use client";

import "./ProductMedia.css";
import { useEffect, useId, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import TextAlign from "@tiptap/extension-text-align";
import { BackgroundColor, Color, TextStyle } from "@tiptap/extension-text-style";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Modal } from "../admin-ui";
import { IMAGE_ACCEPT, IMAGE_LABEL, IMAGE_MAX_BYTES } from "./ProductImages";

// 상품 상세 설명 에디터(SA-012 v274): 무료 오픈소스 Tiptap(MIT). 글 · 이미지 · 표를 섞어 쓰고, 저장할 때 서버가 허용한 태그 · 속성만 남긴다(lib/server/products/detailHtml.ts).
// 저장·사진 올리기는 부모가 한다. 이 칸은 HTML을 부모에 알리고(onChange), 새로 고른 사진은 브라우저 주소(blob:)로 끼워 두었다가 부모가 저장할 때 올린다(pending에 파일을 담아 둔다).
export const DETAIL_TEXT_MAX = 20000;
export const DETAIL_IMAGE_MAX = 30;

const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ["href", "target", "rel"],
  img: ["src", "alt", "width", "height"],
  td: ["colspan", "rowspan", "style"],
  th: ["colspan", "rowspan", "style", "scope"],
};
const STYLE_OK = /^(text-align|color|background-color)\s*:/i;

// 에디터가 내보낸 HTML에서 서버가 어차피 지울 군더더기(표 크기 style · colgroup · class · data-*)를 미리 뺀다.
// 그래야 저장 뒤 「허용하지 않는 코드 N곳을 지웠습니다」가 우리 쪽 군더더기로 늘어나지 않는다.
export function cleanEditorHtml(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  doc.querySelectorAll("colgroup").forEach((n) => n.remove());
  doc.body.querySelectorAll("*").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const keep = ALLOWED_ATTRS[tag] ?? [];
    for (const a of Array.from(el.attributes)) {
      if (a.name === "style") {
        const decls = a.value
          .split(";")
          .map((d) => d.trim())
          .filter((d) => STYLE_OK.test(d));
        if (decls.length && tag !== "table") el.setAttribute("style", decls.join(";"));
        else el.removeAttribute("style");
      } else if (!keep.includes(a.name)) el.removeAttribute(a.name);
    }
  });
  return doc.body.innerHTML === "<p></p>" ? "" : doc.body.innerHTML;
}

// 예전 글·사진 블록을 에디터 HTML로 바꾼다(처음 열 때만)
export function blocksToHtml(blocks: ({ type: "text"; text: string } | { type: "image"; imageId: string; url: string })[]): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return blocks
    .map((b) => (b.type === "text" ? b.text.split("\n").map((l) => `<p>${esc(l)}</p>`).join("") : `<img src="${esc(b.url)}">`))
    .join("");
}

// 에디터 안의 새 사진(blob:) 주소 → 올릴 파일. 부모가 저장할 때 읽는다
export type PendingImages = Map<string, File>;

const PALETTE = ["#111111", "#d92d20", "#f79009", "#12b76a", "#1570ef", "#7a5af8", "#667085", "#ffffff"];

export default function ProductDetailEditor({
  initialHtml,
  disabled,
  pending,
  onChange,
  onReady,
}: {
  initialHtml: string;
  disabled?: boolean;
  pending: React.MutableRefObject<PendingImages>;
  onChange: (html: string, textLength: number) => void;
  onReady?: (html: string) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const [preview, setPreview] = useState(false);
  const [palette, setPalette] = useState<null | "color" | "bg">(null);
  const [link, setLink] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [len, setLen] = useState(0);

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    content: initialHtml,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2] },
        code: false,
        codeBlock: false,
        blockquote: false,
        link: { openOnClick: false, autolink: false, HTMLAttributes: {} },
      }),
      TextStyle,
      Color,
      BackgroundColor,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Image.configure({ inline: false, allowBase64: false }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    editorProps: { attributes: { class: "pm-ed-body", "aria-label": "상세 설명 본문", role: "textbox", "aria-multiline": "true" } },
    onCreate: ({ editor: e }) => {
      setLen(e.getText().length);
      onReady?.(cleanEditorHtml(e.getHTML()));
    },
    onUpdate: ({ editor: e }) => {
      const n = e.getText().length;
      setLen(n);
      onChange(cleanEditorHtml(e.getHTML()), n);
    },
  });
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const st = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            block: e.isActive("heading", { level: 1 }) ? "h1" : e.isActive("heading", { level: 2 }) ? "h2" : "p",
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            strike: e.isActive("strike"),
            ul: e.isActive("bulletList"),
            ol: e.isActive("orderedList"),
            left: e.isActive({ textAlign: "left" }),
            center: e.isActive({ textAlign: "center" }),
            right: e.isActive({ textAlign: "right" }),
            link: e.isActive("link"),
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
          }
        : null,
  });

  const imageCount = () => (editor ? editor.getHTML().split("<img").length - 1 : 0);
  const addImage = (f: File | undefined) => {
    if (!f || !editor) return;
    if (!(IMAGE_ACCEPT as readonly string[]).includes(f.type)) return setProblem(`${IMAGE_LABEL}만 넣을 수 있습니다`);
    if (f.size > IMAGE_MAX_BYTES) return setProblem(`올리지 못했습니다 · 5MB를 넘습니다(${(f.size / 1024 / 1024).toFixed(1)}MB)`);
    if (imageCount() >= DETAIL_IMAGE_MAX) return setProblem(`상세 이미지는 ${DETAIL_IMAGE_MAX}장까지 넣을 수 있습니다`);
    setProblem(null);
    const url = URL.createObjectURL(f);
    pending.current.set(url, f);
    editor.chain().focus().setImage({ src: url, alt: "" }).run();
  };

  const uid = useId();
  if (!editor || !st) return <div className="pm-ed" aria-busy="true" />;
  const run = (fn: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => fn(editor.chain().focus()).run();
  const tb = (label: string, active: boolean, onClick: () => void, text: React.ReactNode, disabledBtn = false) => (
    <button key={label} type="button" className={`pm-tb${active ? " is-on" : ""}`} aria-label={label} aria-pressed={active} disabled={disabled || disabledBtn} onClick={onClick}>
      {text}
    </button>
  );

  return (
    <div className="pm-ed" data-testid="detail-editor">
      <div className="pm-ed-bar" role="toolbar" aria-label="상세 설명 도구">
        <select
          className="inp pm-ed-block"
          aria-label="글 모양"
          disabled={disabled}
          value={st.block}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "p") run((c) => c.setParagraph());
            else run((c) => c.setHeading({ level: v === "h1" ? 1 : 2 }));
          }}
        >
          <option value="p">본문</option>
          <option value="h1">제목 1</option>
          <option value="h2">제목 2</option>
        </select>
        <span className="pm-ed-sep" aria-hidden="true" />
        {tb("굵게", st.bold, () => run((c) => c.toggleBold()), <b>B</b>)}
        {tb("기울임", st.italic, () => run((c) => c.toggleItalic()), <i>I</i>)}
        {tb("밑줄", st.underline, () => run((c) => c.toggleUnderline()), <u>U</u>)}
        {tb("글자 줄 긋기", st.strike, () => run((c) => c.toggleStrike()), <s>S</s>)}
        <span className="pm-pop-wrap">
          <button type="button" className="pm-tb" aria-haspopup="true" aria-expanded={palette === "color"} disabled={disabled} onClick={() => setPalette(palette === "color" ? null : "color")}>
            글자색
          </button>
          {palette === "color" && <Palette name="글자색" onPick={(c) => { run((x) => (c ? x.setColor(c) : x.unsetColor())); setPalette(null); }} />}
        </span>
        <span className="pm-pop-wrap">
          <button type="button" className="pm-tb" aria-haspopup="true" aria-expanded={palette === "bg"} disabled={disabled} onClick={() => setPalette(palette === "bg" ? null : "bg")}>
            배경색
          </button>
          {palette === "bg" && <Palette name="배경색" onPick={(c) => { run((x) => (c ? x.setBackgroundColor(c) : x.unsetBackgroundColor())); setPalette(null); }} />}
        </span>
        <span className="pm-ed-sep" aria-hidden="true" />
        {tb("목록", st.ul, () => run((c) => c.toggleBulletList()), "목록")}
        {tb("번호 목록", st.ol, () => run((c) => c.toggleOrderedList()), "번호 목록")}
        <span className="pm-ed-sep" aria-hidden="true" />
        {tb("왼쪽", st.left, () => run((c) => c.setTextAlign("left")), "왼쪽")}
        {tb("가운데", st.center, () => run((c) => c.setTextAlign("center")), "가운데")}
        {tb("오른쪽", st.right, () => run((c) => c.setTextAlign("right")), "오른쪽")}
        <span className="pm-ed-sep" aria-hidden="true" />
        {tb("이미지 넣기", false, () => file.current?.click(), "이미지 넣기")}
        {tb("표 넣기", false, () => setTable(true), "표 넣기")}
        {tb("구분선", false, () => run((c) => c.setHorizontalRule()), "구분선")}
        <span className="pm-pop-wrap">
          <button type="button" className={`pm-tb${st.link ? " is-on" : ""}`} aria-label="링크" aria-pressed={st.link} disabled={disabled} onClick={() => setLink(link === null ? (editor.getAttributes("link").href ?? "") : null)}>
            링크
          </button>
          {link !== null && (
            <form
              className="pm-pop pm-link"
              onSubmit={(e) => {
                e.preventDefault();
                const url = link.trim();
                if (url === "") run((c) => c.unsetLink());
                else if (/^(https?:\/\/|mailto:|tel:)/i.test(url)) run((c) => c.setLink({ href: url }));
                else return setProblem("링크는 http · https · mailto · tel 주소만 넣을 수 있습니다");
                setProblem(null);
                setLink(null);
              }}
            >
              <input className="inp" aria-label="링크 주소" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} />
              <button className="btn btn-sm" type="submit">적용</button>
            </form>
          )}
        </span>
        <span className="pm-ed-sep" aria-hidden="true" />
        {tb("되돌리기", false, () => run((c) => c.undo()), "되돌리기", !st.canUndo)}
        {tb("다시 실행", false, () => run((c) => c.redo()), "다시 실행", !st.canRedo)}
        <span className="pm-ed-grow" />
        <button type="button" className="pm-tb" onClick={() => setPreview(true)}>
          미리보기
        </button>
      </div>
      <EditorContent editor={editor} />
      <div className="pm-ed-foot">
        <span>무료 오픈소스 에디터 · 저장할 때 서버가 허용한 태그 · 속성만 남깁니다(스크립트 · 외부 코드 제거)</span>
        <span className={len > DETAIL_TEXT_MAX ? "err" : undefined}>
          이미지 가로 860px 권장 · 장당 5MB · 글자 {len.toLocaleString("ko-KR")} / {DETAIL_TEXT_MAX.toLocaleString("ko-KR")}자
        </span>
      </div>
      {problem && (
        <span className="err" role="alert">
          {problem}
        </span>
      )}
      <input
        ref={file}
        type="file"
        accept={IMAGE_ACCEPT.join(",")}
        hidden
        aria-label="상세 이미지 파일"
        onChange={(e) => {
          addImage(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {table && (
        <TableDialog
          idBase={uid}
          onClose={() => setTable(false)}
          onInsert={(rows, cols, header) => {
            run((c) => c.insertTable({ rows, cols, withHeaderRow: header }));
            setTable(false);
          }}
        />
      )}
      {preview && (
        <Modal labelId={`${uid}-pv`} className="pm-pv-modal" onClose={() => setPreview(false)}>
          {(requestClose) => (
            <>
              <div className="modal-h">
                <h2 className="modal-t" id={`${uid}-pv`}>
                  상세 페이지 · 미리보기
                </h2>
              </div>
              <div className="pm-pv-phone">
                <div className="pm-pv-tabs" aria-hidden="true">
                  <b>상세 정보</b>
                  <span>리뷰</span>
                  <span>문의</span>
                  <span>배송 · 환불</span>
                </div>
                <div className="pm-ed-body pm-pv-body" data-testid="detail-preview" dangerouslySetInnerHTML={{ __html: cleanEditorHtml(editor.getHTML()) }} />
              </div>
              <p className="help">구매자 상품 상세의 「상세 정보」 탭에 쓴 순서 그대로 보입니다 · PC는 가로 860px 가운데, 휴대폰은 화면 폭에 맞춥니다</p>
              <div className="modal-f">
                <button type="button" className="btn btn-out btn-w-md" onClick={requestClose}>
                  닫기
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function Palette({ name, onPick }: { name: string; onPick: (color: string | null) => void }) {
  return (
    <div className="pm-pop pm-pal" role="group" aria-label={`${name} 고르기`}>
      {PALETTE.map((c) => (
        <button key={c} type="button" className="pm-sw" style={{ background: c }} aria-label={`${name} ${c}`} onClick={() => onPick(c)} />
      ))}
      <button type="button" className="btn btn-sm btn-out" onClick={() => onPick(null)}>
        지우기
      </button>
    </div>
  );
}

function TableDialog({ idBase, onClose, onInsert }: { idBase: string; onClose: () => void; onInsert: (rows: number, cols: number, header: boolean) => void }) {
  const [rows, setRows] = useState("3");
  const [cols, setCols] = useState("3");
  const [header, setHeader] = useState(true);
  const r = Number(rows);
  const c = Number(cols);
  const ok = Number.isInteger(r) && Number.isInteger(c) && r >= 1 && r <= 20 && c >= 1 && c <= 8;
  return (
    <Modal labelId={`${idBase}-tb`} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id={`${idBase}-tb`}>
              표 넣기
            </h2>
          </div>
          <div className="col" style={{ gap: 10 }}>
            <label className="row" style={{ gap: 8, alignItems: "center" }}>
              <span style={{ width: 40 }}>줄</span>
              <input className="inp num" inputMode="numeric" style={{ width: 80 }} value={rows} onChange={(e) => setRows(e.target.value)} />
            </label>
            <label className="row" style={{ gap: 8, alignItems: "center" }}>
              <span style={{ width: 40 }}>칸</span>
              <input className="inp num" inputMode="numeric" style={{ width: 80 }} value={cols} onChange={(e) => setCols(e.target.value)} />
            </label>
            <label className="chk">
              <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />첫 줄을 제목 줄로
            </label>
            {!ok && <span className="err">줄은 1~20, 칸은 1~8까지 넣을 수 있습니다</span>}
          </div>
          <div className="modal-f">
            <button type="button" className="btn btn-out btn-w-md" onClick={requestClose}>
              취소
            </button>
            <button type="button" className="btn btn-w-md" disabled={!ok} onClick={() => onInsert(r, c, header)}>
              표 넣기
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
