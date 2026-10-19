import Workspace from "../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ couponId: string }>; searchParams: Promise<{ returnTo?: string; copyId?: string; ids?: string }> }) {
  const q = await searchParams;
  return <Workspace key={String(q.ids)} view="bulk" ids={typeof q.ids === "string" ? q.ids : ""} returnTo={q.returnTo} />;
}
