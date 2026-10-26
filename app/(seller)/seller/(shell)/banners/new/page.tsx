import Workspace from "../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ itemId: string }>; searchParams: Promise<{ returnTo?: string; copyId?: string }> }) {
  const q = await searchParams;
  return <Workspace key={"new"} view="item" itemId="new" copyId={q.copyId} returnTo={q.returnTo} />;
}
