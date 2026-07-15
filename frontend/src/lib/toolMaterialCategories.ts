import type { ToolMaterialCategory } from "../types/toolMaterial";


export type ToolMaterialCategoryIconKey =
  | "drill"
  | "grinding"
  | "saw"
  | "vacuum"
  | "measure"
  | "battery"
  | "hand-tools"
  | "ladder"
  | "testing"
  | "vehicle"
  | "material"
  | "other";

export type ToolMaterialCategoryDefinition = {
  value: ToolMaterialCategory;
  label: string;
  icon: ToolMaterialCategoryIconKey;
};

export const toolMaterialCategoryOptions: ToolMaterialCategoryDefinition[] = [
  { value: "drilling_screwing", label: "Bohren & Schrauben", icon: "drill" },
  { value: "grinding_cutting", label: "Schleifen & Trennen", icon: "grinding" },
  { value: "sawing", label: "Sägen", icon: "saw" },
  { value: "vacuuming", label: "Saugen", icon: "vacuum" },
  { value: "measuring", label: "Messen", icon: "measure" },
  { value: "batteries_charging", label: "Akkus & Laden", icon: "battery" },
  { value: "hand_tools", label: "Handwerkzeuge", icon: "hand-tools" },
  { value: "ladders_work_equipment", label: "Leitern & Arbeitsmittel", icon: "ladder" },
  { value: "testing_equipment", label: "Prüfgeräte", icon: "testing" },
  { value: "vehicle_accessories", label: "Fahrzeugzubehör", icon: "vehicle" },
  { value: "material", label: "Material", icon: "material" },
  { value: "other", label: "Sonstiges", icon: "other" },
];

const fallbackCategory = toolMaterialCategoryOptions[toolMaterialCategoryOptions.length - 1];

export function getToolMaterialCategoryDefinition(
  category: string | null | undefined,
): ToolMaterialCategoryDefinition {
  return toolMaterialCategoryOptions.find((option) => option.value === category) ?? fallbackCategory;
}
