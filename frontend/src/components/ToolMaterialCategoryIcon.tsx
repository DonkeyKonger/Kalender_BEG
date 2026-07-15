import {
  Axe,
  BatteryCharging,
  BriefcaseBusiness,
  CarFront,
  Construction,
  Disc3,
  Drill,
  Gauge,
  Hammer,
  PackageOpen,
  Ruler,
  Wind,
} from "lucide-react";

import {
  getToolMaterialCategoryDefinition,
  type ToolMaterialCategoryIconKey,
} from "../lib/toolMaterialCategories";


const categoryIconComponents = {
  drill: Drill,
  grinding: Disc3,
  saw: Axe,
  vacuum: Wind,
  measure: Ruler,
  battery: BatteryCharging,
  "hand-tools": Hammer,
  ladder: Construction,
  testing: Gauge,
  vehicle: CarFront,
  material: PackageOpen,
  other: BriefcaseBusiness,
} satisfies Record<ToolMaterialCategoryIconKey, typeof Drill>;

export function ToolMaterialCategoryIcon({
  category,
  size = 22,
}: {
  category: string | null | undefined;
  size?: number;
}) {
  const definition = getToolMaterialCategoryDefinition(category);
  const Icon = categoryIconComponents[definition.icon];
  return <Icon aria-hidden="true" size={size} strokeWidth={1.9} />;
}
