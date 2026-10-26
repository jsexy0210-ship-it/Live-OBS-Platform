import Workspace from "../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ reviewId: string }>; searchParams: Promise<{ returnTo?: string; ids?: string; action?: string }> }) {
  const q = await searchParams;
  return <Workspace key={String(q.ids) + String(q.action)} view="bulk" ids={typeof q.ids === "string" ? q.ids : ""} action={q.action} returnTo={q.returnTo} />;
}
