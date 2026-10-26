import Workspace from "../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ reviewId: string }>; searchParams: Promise<{ returnTo?: string; ids?: string; action?: string }> }) {
  const q = await searchParams;
  return <Workspace key={(await params).reviewId} view="detail" reviewId={(await params).reviewId} returnTo={q.returnTo} />;
}
