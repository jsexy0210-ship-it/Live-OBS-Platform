import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    "",
    "/commute/",
    "/salary/",
    "/weekends/",
    "/work-time/",
    "/ranking/",
    "/career/",
    "/subscriptions/",
    "/survival/",
    "/about/",
    "/privacy/"
  ];

  return routes.map((route) => ({
    url: `${SITE_URL}${route}`,
    changeFrequency: "weekly",
    priority: route === "" ? 1 : 0.8
  }));
}
