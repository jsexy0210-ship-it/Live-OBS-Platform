import Workspace from "../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ couponId: string }>; searchParams: Promise<{ returnTo?: string; copyId?: string; ids?: string; selectionKey?: string }> }) {
  const q = await searchParams;
  return <Workspace key={String(q.ids) + String(q.selectionKey)} view="bulk" ids={typeof q.ids === "string" ? q.ids : ""} selectionKey={typeof q.selectionKey === "string" ? q.selectionKey : undefined} returnTo={q.returnTo} />;
}
