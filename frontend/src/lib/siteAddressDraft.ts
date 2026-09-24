import type { SiteCreate } from "../types/site";

export type SiteAddressField = "postal_code" | "city" | "street" | "house_number";

export function updateSiteAddressDraft(
  draft: SiteCreate,
  field: SiteAddressField,
  value: string,
): Partial<SiteCreate> {
  const nextValue = value || null;
  if (nextValue === draft[field]) return {};
  const next = { ...draft, [field]: nextValue };
  const streetLine = [next.street, next.house_number].filter(Boolean).join(" ");
  const cityLine = [next.postal_code, next.city].filter(Boolean).join(" ");
  return {
    [field]: nextValue,
    ...(field === "city" ? { location: nextValue } : {}),
    address: [streetLine, cityLine].filter(Boolean).join(", ") || null,
    // Like manual changes in the project record, a correction needs a new location check.
    latitude: null,
    longitude: null,
    location_status: "unchecked",
  };
}
