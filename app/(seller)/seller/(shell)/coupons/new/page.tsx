import Workspace from "../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ couponId: string }>; searchParams: Promise<{ returnTo?: string; copyId?: string; ids?: string }> }) {
  const q = await searchParams;
  return <Workspace key={"new"} view="item" couponId="new" copyId={q.copyId} returnTo={q.returnTo} />;
}
