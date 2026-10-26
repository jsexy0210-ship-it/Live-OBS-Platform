import Workspace from "../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ itemId: string }>; searchParams: Promise<{ returnTo?: string; copyId?: string }> }) {
  const q = await searchParams;
  return <Workspace key={"order"} view="order" returnTo={q.returnTo} />;
}
