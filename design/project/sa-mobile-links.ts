const mobileIds = new Set(["SA-002-M", "SA-012-M", "SA-021-M", "SA-022-M", "SA-023-M", "SA-025-M", "SA-052-M", "SA-053-M", "SA-113-M", "SA-114-M", "SA-120-M"]);

export const mobileDesignHref = (id: string) => mobileIds.has(id)
  ? `/mobile/${id}`
  : `/design/project/${id}.dc.html`;
