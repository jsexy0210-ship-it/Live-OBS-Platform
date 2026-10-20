import Workspace from "../../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ couponId: string }>; searchParams: Promise<{ returnTo?: string; copyId?: string; ids?: string }> }) {
  const q = await searchParams;
  return <Workspace key={(await params).couponId} view="grant" couponId={(await params).couponId} returnTo={q.returnTo} />;
}
