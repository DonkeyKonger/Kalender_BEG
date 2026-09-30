import type { WarehousePerson, WarehouseTool } from "../types/warehouse";
import type { CustomerSignatureStroke } from "../types/site";

export function filterWarehousePeople(people: WarehousePerson[], search: string): WarehousePerson[] {
  const needle = search.trim().toLocaleLowerCase("de");
  return people.filter((person) => `${person.display_name} ${person.short_code}`.toLocaleLowerCase("de").includes(needle));
}

export function toggleWarehouseTool(items: WarehouseTool[], item: WarehouseTool): WarehouseTool[] {
  // A BEG number can identify a set; never use it as the physical item's identity.
  if (items.some((selected) => selected.id === item.id)) return items.filter((selected) => selected.id !== item.id);
  return items.length < 100 ? [...items, item] : items;
}

export function hasWarehouseSignature(strokes: CustomerSignatureStroke[]): boolean {
  return strokes.some((stroke) => stroke.some((point) => point.x !== stroke[0]?.x || point.y !== stroke[0]?.y));
}

export function warehouseToolIdentity(item: WarehouseTool): string {
  return [item.device_number ? `Gerät ${item.device_number}` : "", item.serial_number ? `SN ${item.serial_number}` : ""]
    .filter(Boolean).join(" · ") || `Eintrag #${item.id}`;
}
