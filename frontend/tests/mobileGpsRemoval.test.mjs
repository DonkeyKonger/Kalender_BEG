import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontendRoot = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, frontendRoot), "utf8");
}

test("mobile app no longer contains a phone GPS capture or tracking path", async () => {
  const [assignments, api, manifest, mainActivity] = await Promise.all([
    source("src/pages/MyAssignmentsPage.tsx"),
    source("src/lib/api.ts"),
    source("android/app/src/main/AndroidManifest.xml"),
    source("android/app/src/main/java/de/beg/kalenderbaustellen/MainActivity.java"),
  ]);

  assert.doesNotMatch(assignments, /mobileGps|GpsTracking|Standortprüfung|Android-Hintergrundstandort/i);
  assert.doesNotMatch(api, /gps\/location-points|GpsLocationPoint|recentGpsLocationPoints/);
  assert.doesNotMatch(manifest, /ACCESS_(?:COARSE|FINE|BACKGROUND)_LOCATION|FOREGROUND_SERVICE_LOCATION|AndroidBackgroundGps/i);
  assert.doesNotMatch(mainActivity, /AndroidBackgroundGps/);
});

test("desktop diagnostics retain manual and vehicle GPS sources without phone GPS UI", async () => {
  const page = await source("src/pages/TimeEntriesPage.tsx");

  assert.doesNotMatch(page, /gpsVerification|GPS-Prüfung|Handy[ -]?GPS|mobile Standortsendungen/i);
  assert.match(page, /source: "Eingetragene Monteursstunden"/);
  assert.match(page, /source: "Erkannte Fahrzeug GPS Stunden"[\s\S]*?start: formatTimeEntryClock\(entry\.gps_first_seen_at\)[\s\S]*?total: formatTimeEntryMinutes\(entry\.gps_work_minutes, "hours"\)/);
  assert.match(page, /source: "Eingetragene Monteursbaustelle"/);
  assert.match(page, /source: "Erkannte Fahrzeug-GPS-Baustelle"[\s\S]*?siteName: hasGpsSiteMatch\(entry\)/);
});

test("backend accepts no phone upload route and evaluates only vehicle GPS points", async () => {
  const [main, gpsService, enumSource, personModel] = await Promise.all([
    source("../backend/app/main.py"),
    source("../backend/app/services/gps_service.py"),
    source("../backend/app/models/enums.py"),
    source("../backend/app/models/person.py"),
  ]);

  assert.doesNotMatch(main, /app\.include_router\(gps\.router/);
  assert.doesNotMatch(gpsService, /GpsSourceType\.PHONE|create_location_point|list_recent_location_points/);
  assert.match(gpsService, /GpsPoint\.source_type == GpsSourceType\.VEHICLE/);
  assert.match(gpsService, /VehiclePositionLog/);
  assert.match(enumSource, /PHONE = "phone"/);
  assert.match(personModel, /Persistierte Altspalte der entfernten Handy-GPS-Funktion/);
});
