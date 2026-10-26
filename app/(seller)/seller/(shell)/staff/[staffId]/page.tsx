import Workspace from "../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ staffId: string }>; searchParams: Promise<{ returnTo?: string; operation?: string }> }) {
  const q = await searchParams;
  return <Workspace key={(await params).staffId + (q.operation ?? "edit")} staffId={(await params).staffId} operation={q.operation} returnTo={q.returnTo} />;
}
