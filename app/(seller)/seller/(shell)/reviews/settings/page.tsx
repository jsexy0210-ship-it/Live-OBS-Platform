import Workspace from "../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ reviewId: string }>; searchParams: Promise<{ returnTo?: string; ids?: string; action?: string }> }) {
  const q = await searchParams;
  return <Workspace view="policy" returnTo={q.returnTo} />;
}
