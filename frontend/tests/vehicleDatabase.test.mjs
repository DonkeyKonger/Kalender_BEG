import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panelSource = readFileSync(new URL("../src/components/VehicleDatabasePanel.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../src/pages/MiscellaneousPage.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("vehicles tab renders the database instead of the placeholder", () => {
  assert.match(pageSource, /activeTab\.key === "vehicles"[\s\S]*<VehicleDatabasePanel \/>/);
  assert.match(panelSource, /<h2>Fahrzeuge<\/h2>/);
  assert.match(panelSource, /Zentrale Fahrzeug- und Zuordnungsliste\./);
  assert.match(panelSource, /Fahrzeug hinzufügen/);
});

test("vehicle table exposes exactly the requested sortable columns", () => {
  assert.match(panelSource, /license_plate", label: "Kennzeichen"/);
  assert.match(panelSource, /manufacturer", label: "Hersteller"/);
  assert.match(panelSource, /employee", label: "Monteur"/);
  assert.match(panelSource, /ctrack", label: "C-Track-Verknüpfung"/);
  assert.match(panelSource, /updateSort\(column\.key\)/);
  assert.match(panelSource, /item\.assigned_person\?\.display_name \?\? "Nicht zugewiesen"/);
  assert.match(panelSource, /item\.ctrack_vehicle\?\.label \?\? "Nicht verknüpft"/);
});

test("vehicle form uses the common picker and stable IDs", () => {
  assert.match(panelSource, /<DashboardNotePicker[\s\S]*emptyOptionLabel="Nicht zugewiesen"/);
  assert.match(panelSource, /<DashboardNotePicker[\s\S]*emptyOptionLabel="Nicht verknüpft"/);
  assert.match(panelSource, /assigned_person_id: draft\.employeeId \? Number\(draft\.employeeId\) : null/);
  assert.match(panelSource, /ctrack_vehicle_asset_id: draft\.ctrackVehicleId \? Number\(draft\.ctrackVehicleId\) : null/);
  assert.match(panelSource, /vehicle\.linked_vehicle_id === null \|\| vehicle\.linked_vehicle_id === currentVehicleId/);
});

test("vehicle API keeps CRUD and C-Track source separate", () => {
  assert.match(apiSource, /vehicleDatabaseItems[\s\S]*\/admin\/vehicles/);
  assert.match(apiSource, /vehicleDatabaseOptions[\s\S]*\/admin\/vehicles\/options/);
  assert.match(apiSource, /deleteVehicleDatabaseItem[\s\S]*method: "DELETE"/);
  assert.doesNotMatch(apiSource, /deleteCtrack|removeCtrack/);
});

test("vehicle database keeps the square Office table style", () => {
  assert.match(styles, /\.vehicle-database-panel \{[\s\S]*min-height:/);
  assert.match(styles, /\.vehicle-sort-trigger \{[\s\S]*border-radius:\s*0/);
  assert.match(styles, /\.vehicle-col-ctrack \{\s*width:\s*28%/);
});
