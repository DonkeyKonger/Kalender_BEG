import type { PersonMapItem } from "../types/person";
import type { SiteMapItem } from "../types/site";

export type RoutePlace = {
  key: string;
  kind: "person" | "site";
  name: string;
  address: string;
  searchText: string;
  latitude: number;
  longitude: number;
};
export type RouteField = { query: string; place: RoutePlace | null };
export type RouteFields = [RouteField, RouteField];
export type DrivingRoute = { distanceMeters: number; durationSeconds: number };

export function siteRoutePlace(site: SiteMapItem): RoutePlace {
  const address = [
    [site.street, site.house_number].filter(Boolean).join(" "),
    [site.postal_code, site.city].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ");
  const name = [site.number, site.name].filter(Boolean).join(" · ");
  return { key: `site-${site.id}`, kind: "site", name, address, searchText: `${name} ${address}`, latitude: site.latitude, longitude: site.longitude };
}

export function personRoutePlace(person: PersonMapItem): RoutePlace {
  const address = person.address_formatted || [person.address_postal_code, person.address_city].filter(Boolean).join(" ");
  return {
    key: `person-${person.id}`, kind: "person", name: person.display_name, address,
    searchText: `${person.display_name} ${person.short_name} ${address}`,
    latitude: person.address_latitude, longitude: person.address_longitude,
  };
}

export function validRouteCoordinates(place: Pick<RoutePlace, "latitude" | "longitude">): boolean {
  return Number.isFinite(place.latitude) && Math.abs(place.latitude) <= 90
    && Number.isFinite(place.longitude) && Math.abs(place.longitude) <= 180;
}

export function buildRoutePlaces(sites: SiteMapItem[], people: PersonMapItem[]): RoutePlace[] {
  return [
    ...people.filter((person) => person.active).map(personRoutePlace),
    ...sites.filter((site) => site.status === "active").map(siteRoutePlace),
  ].filter(validRouteCoordinates).sort((a, b) => a.name.localeCompare(b.name, "de", { numeric: true }));
}

function normalizeSearch(value: string): string {
  return value.toLocaleLowerCase("de").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss");
}

export function searchRoutePlaces(places: RoutePlace[], query: string): RoutePlace[] {
  const terms = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  return places.filter((place) => terms.every((term) => normalizeSearch(place.searchText).includes(term)));
}

// A typed but not yet selected address also occupies its field. Never overwrite it.
export function fillNextRouteField(fields: RouteFields, place: RoutePlace): RouteFields {
  if (!validRouteCoordinates(place)) return fields;
  const index = fields.findIndex((field) => !field.query.trim() && !field.place);
  if (index < 0) return fields;
  const next: RouteFields = [...fields];
  next[index] = { query: place.name, place };
  return next;
}

export function formatDrivingRoute(route: DrivingRoute): string {
  const kilometers = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(route.distanceMeters / 1000);
  const minutes = Math.max(route.durationSeconds > 0 ? 1 : 0, Math.round(route.durationSeconds / 60));
  const hours = Math.floor(minutes / 60);
  const duration = hours ? `${hours} Std.${minutes % 60 ? ` ${minutes % 60} Min.` : ""}` : `${minutes} Min.`;
  return `${kilometers} km · ca. ${duration}`;
}

const ROUTE_URL = "https://routing.openstreetmap.de/routed-car/route/v1/driving/";
const UNAVAILABLE = "Fahrstrecke derzeit nicht verfügbar. Bitte Internetverbindung prüfen oder erneut versuchen.";

function waitForRouteSlot(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Interactive requests only: serialized, at most one per second, with a bounded memory cache.
 * Only coordinates leave the browser; application credentials and names are never sent.
 * The browser request also works with the deliberately offline local-calendar backend.
 */
export function createDrivingRouteClient({
  fetcher = fetch, minimumIntervalMs = 1100, timeoutMs = 12000, cacheTtlMs = 300000,
}: { fetcher?: typeof fetch; minimumIntervalMs?: number; timeoutMs?: number; cacheTtlMs?: number } = {}) {
  const cache = new Map<string, { expires: number; route: DrivingRoute }>();
  let queue: Promise<unknown> = Promise.resolve();
  let lastRequest = 0;
  return (start: RoutePlace, end: RoutePlace, signal: AbortSignal): Promise<DrivingRoute> => {
    const run = async (): Promise<DrivingRoute> => {
      signal.throwIfAborted();
      if (!validRouteCoordinates(start) || !validRouteCoordinates(end)) throw new Error("Für diese Adresse fehlen gültige Kartenkoordinaten.");
      if (start.latitude === end.latitude && start.longitude === end.longitude) return { distanceMeters: 0, durationSeconds: 0 };
      const coordinates = `${start.longitude},${start.latitude};${end.longitude},${end.latitude}`;
      const cached = cache.get(coordinates);
      if (cached && cached.expires > Date.now()) return cached.route;
      await waitForRouteSlot(Math.max(0, lastRequest + minimumIntervalMs - Date.now()), signal);
      signal.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      lastRequest = Date.now();
      try {
        const response = await fetcher(`${ROUTE_URL}${coordinates}?overview=false&steps=false&alternatives=false&radiuses=1000;1000`, {
          signal: controller.signal, credentials: "omit", referrerPolicy: "strict-origin-when-cross-origin",
        });
        const payload = await response.json();
        if (payload?.code === "NoRoute" || payload?.code === "NoSegment") throw new Error("Zwischen diesen Adressen wurde keine befahrbare Route gefunden.");
        const route = payload?.routes?.[0];
        if (!response.ok || payload?.code !== "Ok" || typeof route?.distance !== "number" || typeof route?.duration !== "number"
          || !Number.isFinite(route.distance) || !Number.isFinite(route.duration) || route.distance < 0 || route.duration < 0) {
          throw new Error(UNAVAILABLE);
        }
        signal.throwIfAborted();
        const result = { distanceMeters: route.distance, durationSeconds: route.duration };
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(coordinates, { expires: Date.now() + cacheTtlMs, route: result });
        return result;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && (error.message === UNAVAILABLE || error.message.startsWith("Zwischen diesen"))) throw error;
        throw new Error(UNAVAILABLE);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    };
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  };
}

export const getDrivingRoute = createDrivingRouteClient();
