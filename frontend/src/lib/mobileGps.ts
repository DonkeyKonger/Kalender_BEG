import { Capacitor, registerPlugin } from "@capacitor/core";

import { ApiError, api, getAccessToken, getApiBaseUrl } from "./api";

export const ANDROID_GPS_PING_INTERVAL_MS = 900_000;

type MobileGpsSendResult = {
  sentAt: string;
};

export type AndroidBackgroundGpsStatus = {
  isTracking: boolean;
  intervalMs: number;
  queuedCount: number;
  lastSentAt?: string | null;
  message?: string;
};

export type AndroidGpsPermissionStatus = {
  foregroundLocationGranted: boolean;
  backgroundLocationGranted: boolean;
  notificationsGranted: boolean;
  canRequestForegroundLocation: boolean;
  requiresBackgroundLocationSettings: boolean;
  canOpenAppSettings: boolean;
};

type AndroidBackgroundGpsPlugin = {
  startTracking(options: {
    apiBaseUrl: string;
    accessToken: string;
    source: "android_background_service";
  }): Promise<AndroidBackgroundGpsStatus>;
  stopTracking(): Promise<AndroidBackgroundGpsStatus>;
  getStatus(): Promise<AndroidBackgroundGpsStatus>;
  checkPermissions(): Promise<AndroidGpsPermissionStatus>;
  requestForegroundLocationPermission(): Promise<AndroidGpsPermissionStatus>;
  openAppLocationSettings(): Promise<AndroidGpsPermissionStatus>;
};

const AndroidBackgroundGps = registerPlugin<AndroidBackgroundGpsPlugin>("AndroidBackgroundGps");

export function isAndroidAppContext(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isNativePlatform();
}

export async function startAndroidBackgroundGpsTracking(): Promise<AndroidBackgroundGpsStatus> {
  if (!isAndroidAppContext()) {
    return backgroundGpsUnavailableStatus();
  }
  const accessToken = getAccessToken();
  if (!accessToken) {
    throw new Error("Standortdienst konnte nicht gestartet werden. Bitte erneut anmelden.");
  }

  return AndroidBackgroundGps.startTracking({
    apiBaseUrl: getApiBaseUrl(),
    accessToken,
    source: "android_background_service",
  });
}

export async function stopAndroidBackgroundGpsTracking(): Promise<AndroidBackgroundGpsStatus> {
  if (!isAndroidAppContext()) {
    return backgroundGpsUnavailableStatus();
  }
  return AndroidBackgroundGps.stopTracking();
}

export async function getAndroidBackgroundGpsStatus(): Promise<AndroidBackgroundGpsStatus> {
  if (!isAndroidAppContext()) {
    return backgroundGpsUnavailableStatus();
  }
  return AndroidBackgroundGps.getStatus();
}

export async function checkAndroidGpsPermissions(): Promise<AndroidGpsPermissionStatus> {
  if (!isAndroidAppContext()) {
    return androidGpsPermissionsUnavailable();
  }
  return AndroidBackgroundGps.checkPermissions();
}

export async function requestForegroundLocationPermission(): Promise<AndroidGpsPermissionStatus> {
  if (!isAndroidAppContext()) {
    return androidGpsPermissionsUnavailable();
  }
  return AndroidBackgroundGps.requestForegroundLocationPermission();
}

export async function openAndroidAppLocationSettings(): Promise<AndroidGpsPermissionStatus> {
  if (!isAndroidAppContext()) {
    return androidGpsPermissionsUnavailable();
  }
  return AndroidBackgroundGps.openAppLocationSettings();
}

export async function sendCurrentGpsLocation(): Promise<MobileGpsSendResult> {
  return sendCurrentLocation();
}

async function sendCurrentLocation(): Promise<MobileGpsSendResult> {
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
    source: "mobile",
    device_id: getMobileGpsDeviceId(),
  });

  return { sentAt: new Date().toISOString() };
}

function backgroundGpsUnavailableStatus(): AndroidBackgroundGpsStatus {
  return {
    isTracking: false,
    intervalMs: ANDROID_GPS_PING_INTERVAL_MS,
    queuedCount: 0,
    message: "Android-Hintergrundstandort ist in diesem Kontext nicht verfügbar.",
  };
}

function androidGpsPermissionsUnavailable(): AndroidGpsPermissionStatus {
  return {
    foregroundLocationGranted: false,
    backgroundLocationGranted: false,
    notificationsGranted: false,
    canRequestForegroundLocation: false,
    requiresBackgroundLocationSettings: false,
    canOpenAppSettings: false,
  };
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

function getMobileGpsDeviceId(): string {
  const userAgent = navigator.userAgent || "webview";
  return `mobile:${userAgent.slice(0, 96)}`;
}

function isGeolocationPositionError(error: unknown): error is GeolocationPositionError {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && "PERMISSION_DENIED" in error
    && "POSITION_UNAVAILABLE" in error
    && "TIMEOUT" in error;
}
