import SA002 from "../../../../project/SA-002-M.dc";
import SA012 from "../../../../project/SA-012-M.dc";
import SA021 from "../../../../project/SA-021-M.dc";
import SA022 from "../../../../project/SA-022-M.dc";
import SA023 from "../../../../project/SA-023-M.dc";
import SA025 from "../../../../project/SA-025-M.dc";
import SA052 from "../../../../project/SA-052-M.dc";
import SA053 from "../../../../project/SA-053-M.dc";
import SA113 from "../../../../project/SA-113-M.dc";
import SA114 from "../../../../project/SA-114-M.dc";
import SA120 from "../../../../project/SA-120-M.dc";
import { notFound } from "next/navigation";

const screens = {"SA-002-M":SA002,"SA-012-M":SA012,"SA-021-M":SA021,"SA-022-M":SA022,"SA-023-M":SA023,"SA-025-M":SA025,"SA-052-M":SA052,"SA-053-M":SA053,"SA-113-M":SA113,"SA-114-M":SA114,"SA-120-M":SA120};

export default async function MobilePreview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const Screen = screens[id as keyof typeof screens];
  if (!Screen) notFound();
  return <Screen />;
}
