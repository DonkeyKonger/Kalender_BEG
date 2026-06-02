import { Capacitor } from "@capacitor/core";

import { ApiError, api } from "./api";

export const ANDROID_GPS_PING_INTERVAL_MS = 900_000;

type MobileGpsSource = "mobile" | "android_app";

type MobileGpsSendResult = {
  sentAt: string;
};

type AndroidGpsPingStatus = {
  type: "sent";
  sentAt: string;
} | {
  type: "error";
  message: string;
};

type AndroidGpsPingStatusHandler = (status: AndroidGpsPingStatus) => void;

let androidGpsTimer: number | null = null;
let androidGpsTimerGeneration = 0;
let androidGpsPingInFlight = false;

export async function sendCurrentGpsLocation(): Promise<MobileGpsSendResult> {
  return sendCurrentLocation({ source: "mobile", deviceIdPrefix: "mobile" });
}

export async function sendAndroidLocationPing(): Promise<MobileGpsSendResult> {
  if (!isAndroidAppContext()) {
    throw new Error("Automatische Standortsendung läuft nur in der Android-App.");
  }
  return sendCurrentLocation({ source: "android_app", deviceIdPrefix: "android_app" });
}

export function isAndroidAppContext(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isNativePlatform();
}

export function startAndroidGpsPingTimer(onStatus?: AndroidGpsPingStatusHandler): boolean {
  if (!isAndroidAppContext()) {
    return false;
  }
  if (androidGpsTimer !== null) {
    return true;
  }

  const generation = androidGpsTimerGeneration;
  void runAndroidGpsPing(onStatus, generation);
  androidGpsTimer = window.setInterval(() => {
    void runAndroidGpsPing(onStatus, generation);
  }, ANDROID_GPS_PING_INTERVAL_MS);
  return true;
}

export function stopAndroidGpsPingTimer(): void {
  if (androidGpsTimer !== null) {
    window.clearInterval(androidGpsTimer);
    androidGpsTimer = null;
  }
  androidGpsTimerGeneration += 1;
}

async function runAndroidGpsPing(onStatus: AndroidGpsPingStatusHandler | undefined, generation: number): Promise<void> {
  if (androidGpsPingInFlight) {
    return;
  }
  androidGpsPingInFlight = true;
  try {
    const result = await sendAndroidLocationPing();
    if (generation === androidGpsTimerGeneration) {
      onStatus?.({ type: "sent", sentAt: result.sentAt });
    }
  } catch (error) {
    if (generation === androidGpsTimerGeneration) {
      onStatus?.({ type: "error", message: formatMobileGpsError(error) });
    }
  } finally {
    androidGpsPingInFlight = false;
  }
}

async function sendCurrentLocation({
  source,
  deviceIdPrefix,
}: {
  source: MobileGpsSource;
  deviceIdPrefix: string;
}): Promise<MobileGpsSendResult> {
  if (!("geolocation" in navigator)) {
    throw new Error("Standort ist auf diesem Gerät nicht verfügbar.");
  }

  const position = await getCurrentPosition();
  const capturedAt = new Date(position.timestamp || Date.now()).toISOString();
  await api.createGpsLocationPoint({
    captured_at: capturedAt,
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy_meters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    source,
    device_id: getMobileGpsDeviceId(deviceIdPrefix),
  });

  return { sentAt: new Date().toISOString() };
}

export function formatMobileGpsError(error: unknown): string {
  if (isGeolocationPositionError(error)) {
    if (error.code === error.PERMISSION_DENIED) {
      return "Standortberechtigung fehlt.";
    }
    if (error.code === error.POSITION_UNAVAILABLE) {
      return "Standort konnte nicht ermittelt werden.";
    }
    if (error.code === error.TIMEOUT) {
      return "Standortabfrage hat zu lange gedauert.";
    }
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Standort konnte nicht gesendet werden. Bitte erneut anmelden.";
    }
    return error.message || "Standort konnte nicht gesendet werden.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Standort konnte nicht gesendet werden.";
}

function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 60_000,
      timeout: 15_000,
    });
  });
}

function getMobileGpsDeviceId(prefix: string): string {
  const userAgent = navigator.userAgent || "webview";
  return `${prefix}:${userAgent.slice(0, 96)}`;
}

function isGeolocationPositionError(error: unknown): error is GeolocationPositionError {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && "PERMISSION_DENIED" in error
    && "POSITION_UNAVAILABLE" in error
    && "TIMEOUT" in error;
}
